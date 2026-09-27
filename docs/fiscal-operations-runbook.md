# Runbook de operação do Fiscal

Este runbook vale para o ambiente atual, que é **somente simulação**. Nenhum documento
aqui tem valor fiscal. Homologação e produção não estão habilitadas; quando forem, este
runbook ganha os passos da autoridade real, que hoje estão no
[runbook da fase 43](fiscal-phase43-runbook.md).

Decisão: [ADR 0055](adr/0055-fiscal-support-reads-metrics-and-bounded-replay.md).
Plano: [fase 48](fiscal-phase48-implementation-plan.md).

## Onde olhar primeiro

1. **Tela de suporte** (`/app/fiscal/support`): comandos em espera, resultados incertos,
   eventos não publicados, importações a conciliar, rejeições dos últimos 7 dias,
   certificados, tuplas suportadas e pacotes de fontes. É a leitura por tenant de
   `GET /fiscal/support/overview`.
2. **Documentos emitidos** (`/app/fiscal/documents`): cada documento com a linha do
   tempo, o que está pendente e o último código de rejeição.
3. **Prometheus** (`http://localhost:9090/alerts`): os alertas `Fiscal*`. As métricas não
   têm tenant; para saber qual tenant, use a tela de suporte ou o CLI.

## Comandos de suporte

Rodam no container do Fiscal, que já tem `DATABASE_URL`:

```sh
docker exec horizon-fiscal node dist/support-cli.js overview --tenant <uuid>
docker exec horizon-fiscal node dist/support-cli.js reconcile-unknown --tenant <uuid> --actor <quem> [--limit N]
docker exec horizon-fiscal node dist/support-cli.js retry-due --tenant <uuid> --actor <quem> [--limit N]
docker exec horizon-fiscal node dist/support-cli.js replay-outbox --tenant <uuid> --actor <quem> \
  --reason "<motivo, 10 a 500 caracteres>" (--document <uuid> | --events <uuid,uuid>) [--limit N]
```

- Cada comando mexe em no máximo 100 linhas e grava uma entrada na auditoria do Fiscal
  (`support.<comando>`).
- A saída é JSON, com o que mudou (`changed`) e o que foi ignorado e por quê (`skipped`).
- Nenhum comando cria documento, número, estoque ou dinheiro:
  - `reconcile-unknown` enfileira a mesma consulta que um operador pediria;
  - `retry-due` só antecipa um job que já estava pendente;
  - `replay-outbox` publica de novo um evento já entregue, com o mesmo `eventId`, que os
    consumidores deduplicam.
- Rodar o mesmo comando duas vezes não repete o efeito: a reconciliação usa a última
  transição do documento como chave, e o replay aceita um só pedido pendente por evento.

## Alertas

### FiscalMetricsAbsent

**Sintoma:** o Fiscal não publica as métricas de suporte há 10 minutos.

**Ação:**
1. Veja se o container `horizon-fiscal` está saudável (`docker ps`) e leia os logs.
2. Confira o collector (`horizon-otel-collector`) e o scrape `otel-collector` no
   Prometheus.
3. Se só as métricas pararam e a API responde, reinicie o Fiscal. O worker retoma a fila
   do ponto em que parou.

### FiscalQueueLag

**Sintoma:** um comando de despacho vencido espera há mais de 5 minutos.

**Ação:**
1. Na tela de suporte, veja quantos comandos esperam e há quanto tempo.
2. Na lista de documentos, filtre pela situação `na fila`, `enviado` ou `resultado
   incerto`. A coluna "Em espera" mostra o comando e a tentativa.
3. Se o worker parou, reinicie o Fiscal.
4. Se o job só aguarda o backoff e a autoridade voltou, rode `retry-due`. O worker ainda
   consulta antes de qualquer reenvio.

### FiscalUnknownOutcomes

**Sintoma:** há documentos com resultado incerto (`unknown` ou `cancellation_unknown`)
há 15 minutos.

**Ação:**
1. Não trate o documento como autorizado nem como rejeitado. A tela mostra esse aviso.
2. Se há um comando pendente, o worker já vai consultar; espere ou rode `retry-due`.
3. Se não há nada pendente (a coluna "Em espera" mostra "nada"), rode
   `reconcile-unknown`. Ele enfileira a consulta: pela chave de acesso nos modelos 55 e
   65, e pela DPS na NFS-e. Só um documento que a autoridade nunca recebeu é reenviado.
4. Se a consulta também fica incerta, registre o caso: pode haver indisponibilidade da
   autoridade.

### FiscalAuthorizationSlow

**Sintoma:** o percentil 95 da latência de autorização passou de 60 segundos.

**Ação:**
1. A latência conta do primeiro comando do documento até o resultado final; ela inclui
   as consultas depois de uma resposta perdida.
2. Na simulação, o cenário `timeout-after-accept` e o atraso de nova tentativa
   (`FISCAL_SIMULATOR_RETRY_DELAY_MS`) aumentam a latência de propósito.
3. Fora da simulação, confira a disponibilidade da autoridade antes de mexer em limites.

### FiscalRejections

**Sintoma:** 5 ou mais rejeições com o mesmo código em 30 minutos.

**Ação:**
1. Na tela de suporte, veja o código e a última ocorrência; na lista de documentos, o
   código aparece ao lado da situação.
2. Uma rejeição repetida costuma vir de um cadastro, perfil ou regra. Corrija a origem e
   crie o documento sucessor (correção) em vez de reenviar o mesmo XML.
3. Na NFS-e, códigos `E0xxx` são do Anexo I. Por exemplo, E0014 é DPS repetida e E0039 é
   município sem emissor nacional.

### FiscalCertificateExpiring

**Sintoma:** um certificado A1 de estabelecimento vence em menos de 30 dias
(`FiscalCertificateExpiring`), ou já venceu (`FiscalCertificateExpired`).

**Ação: rotação do certificado.**
1. A empresa obtém o novo A1 ICP-Brasil do mesmo CNPJ.
2. Um administrador fiscal envia o `.pfx` em **Administração → Workspace → Certificado
   do estabelecimento**. O Fiscal confere o CNPJ, guarda cifrado e passa a usar o novo
   certificado. O anterior fica inativo, mas guardado.
3. Confira na tela de suporte a nova validade.
4. Documentos já assinados continuam válidos com a assinatura que têm.

### FiscalXmlValidationFailures

**Sintoma:** um XML foi recusado por um esquema fixado. O rótulo `schema` diz qual:
`nfe`, `nfe-event`, `nfse`, `sefaz-response` ou `inbound`.

**Ação:**
- `inbound`: o fornecedor mandou um XML fora do PL 010f. A importação respondeu
  `SCHEMA_INVALID`; peça o XML certo.
- `nfe`, `nfe-event` ou `nfse`: o Horizon gerou um XML que o próprio esquema recusa. Isso
  é defeito, e a emissão para antes de enviar. Guarde o documento e abra um incidente.
- `sefaz-response`: a resposta da autoridade não bateu com o esquema revisado. Não
  interprete a resposta.

### FiscalImportsUnmatched

**Sintoma:** há NF-e de fornecedor sem conciliação há um dia.

**Ação:**
1. Em **XML de entrada**, abra a importação.
2. Se há conflito (outro XML com a mesma chave), descarte-o com motivo.
3. Confirme a proposta com o cadastro do fornecedor. Se quantidade ou valor diferem,
   informe o motivo para aceitar as diferenças.
4. Estoque e contas a pagar continuam com Compras e Financeiro (ADR 0051).

### FiscalObjectStoreFailures

**Sintoma:** falhou uma leitura ou gravação de artefato no armazenamento de objetos.

**Ação:**
1. Confira o MinIO (`horizon-minio`) ou o bucket configurado, as credenciais e o espaço.
2. Uma gravação que falha interrompe a emissão antes do envio; ela é retomada quando o
   armazenamento volta.
3. Uma leitura que falha em artefato existente pede restauração (veja abaixo).

### FiscalOutboxStuck

**Sintoma:** um evento fiscal confirmado espera há mais de 10 minutos para ser publicado.

**Ação:**
1. Confira o RabbitMQ e os logs do Fiscal ("Fiscal issue worker cycle failed").
2. O relay publica com confirmação e marca a entrega. Um evento nunca se perde; ele sai
   quando o broker volta.
3. Se um consumidor perdeu um evento já entregue, use `replay-outbox` com o documento ou
   os ids dos eventos.

### FiscalSourcePackageStale

**Sintoma:** um pacote de fontes foi importado há mais de 180 dias.

**Ação:**
1. Confira no [registro de fontes](fiscal-source-register.md) se a fonte oficial mudou
   (nota técnica, leiaute, alíquota de referência).
2. Se mudou, importe e revise o pacote novo antes da próxima liberação de adaptador. Não
   altere um pacote já usado; documentos antigos recalculam com a versão que usaram.

### FiscalServiceIntakesBlocked

**Sintoma:** um serviço faturado no Sales (entrega de ordem de serviço ou período de
contrato) espera há uma hora pela NFS-e, bloqueado.

**Ação:**
1. Liste as entradas bloqueadas: `GET /fiscal/service-intakes?status=blocked`. Para um mês
   de contratos, filtre por `documentType=contract-period&period=AAAA-MM`. O campo `reason`
   diz o que falta.
2. Corrija a causa no lugar certo:
   - `SERVICE_PROFILE_MISSING`: crie a revisão do perfil fiscal do serviço;
   - município sem suporte ou sem estabelecimento: configure a capacidade NFS-e;
   - perfil do cliente ou do emitente ausente: complete o cadastro de origem;
   - E0015: a competência ainda não começou no fuso do emitente, então é só esperar.
3. Peça nova tentativa: `POST /fiscal/service-intakes/{id}/retry`. Sem isso, o worker tenta
   de novo sozinho, com espera crescente de até uma hora.

### FiscalServiceCancellationRefused

**Sintoma:** um serviço foi retirado no Sales (entrega cancelada ou período creditado), mas
a NFS-e já estava fora do prazo municipal de cancelamento.

**Ação:**
1. Encontre a entrada em `GET /fiscal/service-intakes?status=cancellation-refused`. O
   `reason` traz o prazo que expirou.
2. A NFS-e continua autorizada. O ajuste é uma decisão fiscal fora do sistema: por exemplo,
   uma nota de crédito ou o procedimento do município. Registre a decisão.
3. O título do Financeiro já foi retirado ou estornado pelo crédito, ou está sinalizado para
   revisão se havia baixa.

## Restauração de artefatos

Banco e objetos são restaurados **juntos**. Os artefatos são cifrados com uma chave
ligada à chave do objeto, e o banco guarda o digest de cada um.

1. Faça o dump do banco `horizon_fiscal` e a cópia do bucket (ou do volume) no mesmo
   momento de consistência.
2. Suba um Fiscal apontando só para os dados restaurados, com RabbitMQ próprio e sem
   tenant servido pelo worker. Assim ele não emite nem publica nada.
3. Verifique byte a byte com `scripts/phase48-verify-restore.mjs --restored <url>`. O
   script compara a lista de artefatos com o Fiscal vivo e confere tamanho e SHA-256 de
   cada arquivo servido. Outro tenant deve receber 404.
4. O ensaio completo do ambiente local é `scripts/phase48-restore-drill.sh`.

## Backups

- **Banco:** o `horizon_fiscal` guarda:
  - documentos, transições e comandos;
  - observações da autoridade e digests;
  - auditoria encadeada por hash;
  - outbox e pedidos de replay.

  Entra na mesma política de backup dos outros bancos de módulo.
- **Objetos:** o bucket `horizon-fiscal-artifacts` guarda:
  - XML assinado e protocolos;
  - respostas;
  - DANFE;
  - XML de NFS-e e eventos;
  - XML de entrada.

  O bucket precisa de versionamento ou cópia imutável na política do dono da implantação.
- **Chave:** `FISCAL_ARTIFACT_KEY_HEX` cifra artefatos, snapshots e certificados. Sem ela,
  o backup não abre. Guarde-a no cofre de segredos, fora dos backups que ela protege.

## Retenção legal

O Horizon **não fixa** um prazo universal de guarda. O prazo depende do documento, do
tributo e da jurisdição, e é definido e verificado pelo dono da implantação com o
responsável fiscal.

O que o Horizon garante:
- o XML original, a evidência de autorização e os eventos vinculados são append-only;
  cancelamento, carta de correção ou substituição acrescentam registros e nunca apagam o
  original;
- os artefatos têm digest no banco e são conferidos a cada leitura.

A política de expiração do bucket e do backup deve ser pelo menos o prazo definido pelo
dono. Até essa definição, nada expira.
