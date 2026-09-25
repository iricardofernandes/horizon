# Fase 43 — runbook da NF-e 55 em homologação SP

**Estado:** preparação operacional. A [evidência de homologação](fiscal-phase43-evidence.md)
ainda está pendente. Nenhum resultado de simulação autoriza a ativação `homologated`.

## Escopo e responsáveis

Executar somente para o tenant, estabelecimento, série, operação de venda normal e
emissor SP aprovados no [manifesto da fase](fiscal-phase43-source-manifest.json).
O operador executa os comandos internos. O revisor Fiscal, distinto do autor/importador,
aprova fontes, regras, perfil, numeração, resultados do portal e o pacote final.
Sales mantém a expedição configurada bloqueada: homologação não produz autorização
de produção nem libera estoque ou financeiro.

## Pré-condições

1. Confirmar CNPJ/credenciamento, custódia e validade do certificado, cinco URLs de
   homologação, WSDL, operações SOAP e raiz TLS. Registrar seus digests revisados.
   Depois que o A1 for cadastrado no app, executar `npm run phase43:fetch-wsdl --
   --tenant <uuid> --establishment <uuid> --trust-anchor <pem>
   --trust-anchor-fingerprint <sha256> --endpoints <json>
   --output-directory </caminho/fora/do/repositorio>` em `fiscal`. O comando usa
   mTLS, baixa os cinco WSDLs em diretório novo fora do repositório e emite digests
   individuais e `wsdlSetDigest`. O GET sem certificado retornou HTTP 403 em
   2026-09-25. Guardar os bytes para revisão independente; não preencher
   `wsdlReviewed` com base apenas na tentativa de acesso.
2. Reter e revisar os bytes dos pacotes de regras e dos XSDs. Definir capability
   separada da simulação, com `sourceManifestDigest`, `schemaPackageDigest` e fixture.
   Executar `make verify-phase43-sources` para conferir os seis candidatos retidos
   e os XSDs de resposta antes da revisão independente.
3. Registrar a capability e sua revisão pelo comando `phase42:capability` com ações
   `register` e `review`. Registrar faixa, pacotes de cálculo, perfil de emissão e
   XSD de evento pelos comandos `phase43:number-range`,
   `phase43:calculation-approval`, `phase43:issuance-profile` e
   `phase43:event-schema-approval`. Reter e revisar também os dois arquivos ZIP
   de XSD de resposta e registrar `phase43:response-schema-approval -- --file <json>`.
   O JSON exige `tenantId`, `capabilityId`, `sourceManifestDigest`,
   `documentSchemaDigest`, `consultationSchemaDigest` e `reviewedBy`.
   Os digests devem corresponder aos ZIPs passados aos comandos de envio e reparse.
   Não ativar a capability ainda.
4. Conferir que `DATABASE_URL`, `FISCAL_ARTIFACT_KEY_HEX`,
   `FISCAL_ARTIFACT_BUCKET` e `FISCAL_ARTIFACT_REGION` apontam ao mesmo ambiente
   isolado. `FISCAL_ARTIFACT_ENDPOINT` é opcional. No app, em Administração da área
   de trabalho, um administrador Fiscal cadastra o A1 `.pfx`/`.p12` e sua senha
   para o ID do estabelecimento. O servidor extrai o par PEM, cifra certificado
   e chave privada com AES-GCM derivado por tenant e não persiste a senha nem o PFX.
   O cadastro substitui a credencial ativa só daquele estabelecimento; versões
   anteriores continuam cifradas para consultas já vinculadas. Backup do banco
   deve preservar também `FISCAL_ARTIFACT_KEY_HEX` sob custódia separada.
5. Executar build, testes unitários/e2e e migrações em ambiente de ensaio. Fazer
   backup consistente do banco e dos objetos criptografados antes do teste real.

## Job manual de homologação

O workflow `phase43-homologation.yml` executa **uma** troca por disparo manual,
somente em `main`, em um runner Linux dedicado com o rótulo
`fiscal-homologation`. Configurar antes o environment `fiscal-homologation` com
revisores obrigatórios distintos do operador. O runner precisa alcançar apenas o
banco e o bucket isolados de homologação, os cinco endpoints SP revisados e seu
registro local de `@horizon/contracts` na versão fixada. As fontes candidatas
retidas são verificadas novamente no job; isso não substitui a revisão Fiscal.

Montar raiz TLS, arquivos de operações e endpoints revisados e os dois ZIPs de
XSD de resposta fora do repositório. O certificado A1 é selecionado do banco
pelo tenant, estabelecimento do documento e fingerprint do grant/exchange.
Registrar os caminhos e digests nas variáveis de environment `PHASE43_TRUST_ANCHOR_PATH`,
`PHASE43_TRUST_ANCHOR_FINGERPRINT`, `PHASE43_OPERATIONS_PATH`,
`PHASE43_ENDPOINTS_PATH`, `PHASE43_DOCUMENT_RESPONSE_SCHEMA_PATH` e
`PHASE43_CONSULTATION_RESPONSE_SCHEMA_PATH`. Configurar também
`PHASE43_ARTIFACT_BUCKET`, `PHASE43_ARTIFACT_REGION` e, se necessário,
`PHASE43_ARTIFACT_ENDPOINT`. Manter `PHASE43_DATABASE_URL` e
`PHASE43_ARTIFACT_KEY_HEX` como secrets do environment; a credencial AWS do bucket
deve vir da identidade restrita do runner. Não armazenar bytes de certificado ou
chave como variáveis do workflow.

Disparar `resume`, `consult` ou `status` com tenant e exchange IDs previamente
aprovados. `consult` e `status` exigem document ID; `status` também exige grant ID.
O CLI valida o grant, os digests e a capacidade antes de transmitir. O log do job
mostra apenas serviço, códigos, digest da resposta e presença de recibo/protocolo.
Conferir as referências completas no ledger restrito e confrontar o resultado com
o portal oficial; registrar a evidência redigida no documento da fase. O workflow
não aprova fontes, não reconcilia resultados incertos e não ativa a capability.

## Sequência por documento

1. Congelar a origem com Sales em `packed` e criar o draft interno. Conferir o
   tenant, estabelecimento, documento, série e capability aprovada antes de prosseguir.
2. Criar um grant com `phase43:grant -- --file <json>`. O arquivo contém tenant,
   documento, capability, digests de endpoint/WSDL/certificado, operador e expiração
   em até duas horas. Registrar o grant ID na evidência, sem armazenar credenciais.
3. Validar readiness com `phase43:readiness` usando esse grant. Conferir no
   resultado capability, pacote de regras e digest de reconciliação. Um cálculo
   não suportado encerra o ensaio desse documento.
4. Opcionalmente executar `phase43:status` com um novo exchange ID. Confirmar
   `cStat` e digest da resposta em `phase43:observations`.
5. Executar `phase43:issuance-prep` com um exchange ID estável. Conferir chave de
   acesso, número, digest do XML assinado e `sent: false`. Não trocar o exchange ID
   ao repetir a preparação. Conferir o número reservado antes de qualquer envio.
6. Executar `phase43:exchange-resume` para esse exchange ID. Esta ação pode chamar
   a SEFAZ uma vez. Conferir o estado por `phase43:observations` e comparar os
   códigos, recibo e protocolo com o portal oficial antes de classificar o caso.
7. Para `pending` ou envio iniciado sem resposta, executar `phase43:consult` com
   **novo** exchange ID e o documento original. A consulta seleciona recibo ou
   protocolo a partir da evidência persistida. Repetir apenas dentro do orçamento
   de dez consultas. Nunca preparar uma segunda autorização para o documento.
8. Após protocolo autorizado observado, executar `phase43:cancellation-prep` com
   justificativa e horário explícitos. Conferir `sent: false`, então executar
   `phase43:exchange-resume` para o exchange ID do evento. Comparar o `128/135`
   observado e o protocolo com o portal. Registrar digests, não XML protegido.

Após a autorização observada, `phase43:danfe -- --tenant <uuid> --document <uuid>`
gera um PDF de homologação somente a partir do XML assinado e do protocolo
retidos. O comando devolve o digest do artefato `danfe`. Conferir o título, a marca
"HOMOLOGAÇÃO — SEM VALOR FISCAL" em todas as páginas e o rótulo
`environment: homologation`, `fiscalValue: false` na leitura v2. O PDF é um
resumo para o ensaio; não substitui um DANFE de produção.

Usar documentos separados para autorização normal, rejeição de negócio e falha
temporária. O caso de resposta perdida exige consulta e reconciliação manual se
continuar incerto; um `not_found` isolado não libera reenvio.

## Estados e recuperação

| Estado em `phase43:observations` | Ação |
|---|---|
| `prepared` | `phase43:exchange-resume` pode iniciar o único envio. |
| `send_started` | Tratar como incerto; consultar. Repetir o envio é bloqueado. |
| `raw_unparsed` | Usar `phase43:reparse`; lê os bytes armazenados sem rede ou certificado de assinatura. |
| `observed` com `pending` | Consultar pelo recibo/protocolo indicado. |
| `observed` com `authorized`, `rejected` ou `cancelled` | Registrar e confrontar com o portal; não reenviar. |
| Código ou combinação `unknown` | Parar e submeter à reconciliação do operador/revisor. |

Se o grant, certificado ou raiz TLS expirar, parar novas transmissões. Uma resposta
bruta já armazenada pode ser interpretada por `phase43:reparse`. Trocas iniciadas
sem resposta continuam incertas e precisam de consulta com grant/credencial válidos.
Uma falha de objeto criptografado ou digest impede a continuação até restaurar os
bytes corretos. Não criar nova numeração para contornar falha de recuperação.

## Monitoramento, rollback e restauração

Monitorar grant perto do vencimento, certificado perto do limite configurado,
erros TLS, circuito de serviço aberto, consultas perto do limite, trocas
`send_started` sem resposta, `raw_unparsed`, decisão `unknown` e artefatos ausentes.
Alertar o operador Fiscal; não converter automaticamente esses casos em rejeição.

Para parar o rollout, não conceder novos grants e usar
`phase43:activation -- --action deactivate --file <json>` se a capability tiver
sido ativada. Preservar trocas e números existentes. Drenar comandos preparados
por observação e consulta, mantendo incertos para reconciliação; não emitir outra
NF-e com a mesma origem para tentar limpar a fila.

Restaurar banco e objetos criptografados juntos em ambiente isolado. Executar
`phase43:restore-verify -- --tenant <uuid> --document <uuid>` para cada documento;
o comando relê XML assinado, SOAP, respostas e protocolos pelos digests do ledger.
Conferir tenant e capability, processar respostas `raw_unparsed`, demonstrar que
trocas `send_started` não reenviam e que o gate Sales segue bloqueado. Registrar
resultado, horário, operador e digests no documento de evidências.

Somente após autorização, consulta, rejeição, indisponibilidade, cancelamento e
restauração terem evidências reais revisadas, registrar a evidência vinculada pelo
`phase43:activation -- --action evidence --file <json>` e ativar com
`--action activate`. O banco exige os IDs relacionados de autorização, consulta
autorizada e cancelamento. A publicação em produção permanece desabilitada.

## Worker após ativação

O worker normal de Fiscal só processa trocas preparadas **depois** da ativação
`homologated` da capability. Trocas de ensaio preparadas antes dela continuam sob
o comando explícito do operador. A desativação impede novas seleções; marcadores
de envio já gravados continuam incertos até consulta ou reconciliação. O banco
também bloqueia novos marcadores de autorização, evento e estado do serviço após
a desativação; consultas de recibo e protocolo seguem disponíveis para recuperar
um envio já iniciado.

Para habilitar esse worker, montar fora do repositório um JSON e apontar
`FISCAL_PHASE43_WORKER_CONFIG_PATH` para ele. O arquivo contém apenas caminhos e
identificadores, nunca bytes de chave privada:

```json
{
  "trustAnchorPath": "/run/secrets/icp-brasil-root.pem",
  "trustAnchorFingerprint": "<sha256 da raiz>",
  "operationsPath": "/run/secrets/phase43-operations.json",
  "endpointsPath": "/run/secrets/phase43-endpoints.json",
  "documentResponseSchemaPath": "/run/secrets/phase43-document-response.zip",
  "consultationResponseSchemaPath": "/run/secrets/phase43-consultation-response.zip"
}
```

Montar cada arquivo listado no contêiner. O startup valida raiz TLS, endpoints e
arquivos XSD. Cada envio carrega e valida a credencial cifrada do estabelecimento
do documento. O envio ainda exige grant válido, adapter,
WSDL, endpoint, certificado e XSDs iguais aos vínculos revisados no banco.
