# Fase 48 — evidências das telas, operação e suporte

Status: **concluída em simulação em 2026-09-26**.
- Todas as autoridades desta fase são simuladores determinísticos.
- Nenhuma linha de homologação ou produção está habilitada. Por isso a parte "toda linha
  de homologação habilitada" do critério de saída é vazia, e a fase J fecha **só para
  simulação**.
- Este registro não inclui XML integral, chave de acesso, CNPJ, certificado nem chave
  privada.

Plano: [fiscal-phase48-implementation-plan.md](fiscal-phase48-implementation-plan.md).
Decisão: [ADR 0055](adr/0055-fiscal-support-reads-metrics-and-bounded-replay.md).
Operação: [runbook](fiscal-operations-runbook.md).
Ameaças: [modelo de ameaças](fiscal-threat-model.md).

## O que foi entregue

- **Leituras novas do Fiscal** (contratos 0.37.0, só aditivos):
  - `GET /fiscal/documents`: fila de trabalho de todos os modelos, das mais novas para as
    mais antigas, com paginação por cursor, filtros de situação e modelo, o comando
    pendente e o último código de rejeição;
  - `GET /fiscal/support/overview`: fila, situações, resultados incertos, rejeições de 7
    dias, certificados, importações, eventos não publicados, capacidades ativas de todos
    os modelos e idade dos pacotes de fontes.
- **Telas** no grupo "Fiscal" do web, em pt-BR e en:
  - **Documentos emitidos:** lista com filtros. O diálogo do documento mostra o rótulo de
    simulação, a linha do tempo, o cálculo com as fontes, os arquivos para baixar, os
    vínculos e as ações permitidas pelo papel e pela situação (validar, emitir,
    consultar, cancelar, carta de correção e substituir NFS-e).
  - **Prévia de regras:** cenário de uma linha para NF-e 55, NFC-e 65 ou NFS-e, com a
    explicação de cada tributo.
  - **XML de entrada:** upload, lista, revisão da proposta, descarte de conflito e
    download do XML original.
  - **Suporte:** indicadores, rejeições, certificados, documentos por situação, tuplas
    suportadas, tipos de documento, consulta ao registro municipal da NFS-e e pacotes de
    fontes.
  - O painel de certificado passou a mostrar o estado da validade (válido, vence em até
    30 dias, vencido).
- **Métricas:**
  - medidores somados entre os tenants servidos, sem rótulo de tenant: fila (pendentes,
    em lease, idade do mais antigo), resultados incertos, certificados (dias restantes,
    vencendo, vencidos), importações sem conciliação e bloqueadas, outbox não entregue e
    idade, idade do pacote de fontes;
  - contadores `fiscal_authority_outcomes_total` (modelo, família, resultado, código),
    `fiscal_xml_validation_failures_total` (esquema) e
    `fiscal_object_store_failures_total` (operação);
  - histograma `fiscal_authorization_latency_seconds`.
- **Alertas:**
  - 12 regras em `infra/observability/rules/fiscal.rules.yml`, carregadas pelo Prometheus
    local, cada uma com uma âncora do runbook;
  - testadas por `promtool` (`make test-alerts`).
- **Comandos de suporte** (`support-cli`): `overview`, `reconcile-unknown`, `retry-due` e
  `replay-outbox`.
  - Cada um é limitado a 100 linhas, auditado e reaproveita caminhos idempotentes.
  - O replay usa `fiscal_outbox_replays` (migração 0050). O outbox continua imutável, e o
    relay publica de novo com o mesmo `eventId`.

## Critérios de saída

| Critério do roteiro | Evidência |
|---|---|
| `make check` e isolamento de módulos | `make check`: "all projects ok"; fronteiras: 16 projetos ok; pins: `@horizon/contracts@0.37.0` em todos os módulos |
| Suítes de PostgreSQL/RabbitMQ reais, com queda e entre tenants | e2e do Fiscal: 52 passando (os 50 anteriores sem alteração e 2 novos), mais o replay com RabbitMQ real e a checagem de RLS da tabela nova |
| Golden path | `scripts/phase48-golden-path.mjs`: 3 execuções no stack local (tabela abaixo) |
| Fluxos de navegador | `web/scripts/fiscal-workflow.e2e.mjs` em pt-BR e en, e `npm run test:browser` (golden path de navegador existente), ambos passando |
| Restauração de artefatos | `scripts/phase48-restore-drill.sh`: 75 artefatos de 9 documentos (55, 65 e NFS-e) idênticos byte a byte; outro tenant recebe 404; repetido após reiniciar |
| Toda linha de homologação habilitada | nenhuma linha habilitada; a matriz publicada mostra isso |
| Nunca chamar documento simulado de autorizado nem anunciar jurisdição não testada | rótulo "Simulação — sem valor fiscal" em todas as telas; a situação aparece como "autorizado (simulado)"; o teste de navegador confere que não há "autorizado" isolado; a matriz lista só tuplas ativadas; o registro responde "não suportado" para Campinas |

## Verificação

- **Contratos:** 102 testes. Contra a 0.36.0: 0 esquemas removidos, 0 alterados e 3
  adicionados (`fiscal-document-summary-v1`, `fiscal-document-list-v1` e
  `fiscal-support-overview-v1`).
- **Fiscal:**
  - 170 testes unitários, sendo 4 novos: rotas de lista e suporte, estado do
    certificado, rótulos limitados;
  - e2e com 52 testes. O log da execução completa tem SHA-256
    `2f620c03b29d56cf46cd03fdf9f72ee6d5afb2a920ba191f0e2dc565b4c6a8ba`.
  - Os e2e novos cobrem:
    - a fila de trabalho por tenant, com cursor, filtros e cursor inválido;
    - a visão de suporte, com capacidade NFS-e por município e totais sem tenant;
    - `retry-due` e `reconcile-unknown` sobre uma resposta perdida de NFS-e: um envio e
      uma consulta, sem reenvio (E0014);
    - o replay com RabbitMQ real: publicado uma vez com o mesmo `messageId`, pedido
      pendente único, tabela append-only, auditoria.
- **Web:**
  - 43 testes unitários: regras de ações por papel e situação, rótulo de simulação,
    corpo das ações, entrada da prévia, proposta de conciliação, validade do
    certificado, idades;
  - lint, cópia sem texto inline, typecheck e build de produção ok.
- **Alertas:** `promtool check rules` (12 regras) e `promtool test rules` (7 grupos)
  passaram. No Prometheus local:
  - as 12 regras estão carregadas e saudáveis;
  - `FiscalImportsUnmatched` ficou *pending* por causa da NF-e de fornecedor deixada
    aberta pelo teste de navegador; ela dispararia depois de 24 horas.
- **Outros:** links da documentação e 21 testes de scripts ok.

### Golden path no stack local

`scripts/phase48-golden-path.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`:
1. **Venda:**
   - orçamento enviado e aceito, convertido em pedido;
   - expedição separada, embalada e despachada;
   - NF-e 55 da origem do Sales, validada, emitida e autorizada em simulação.

   Verificado:
   - estoque −2 e exatamente um recebível para o cliente;
   - a autorização não acrescentou movimento nem recebível;
   - a fila de trabalho mostra a NF-e `authorized`, `simulated`, sem valor fiscal e sem
     pendência;
   - todos os artefatos baixados conferem com o SHA-256.
2. **Compra:** o smoke da fase 44 roda como filho:
   - pedido, recebimento parcial de 6 unidades e conta a pagar lançada;
   - NF-e de fornecedor importada duas vezes e conciliada uma vez;
   - evento de recebimento repetido no broker.

   Resultado: um recebimento, uma conta a pagar e importação `reconciled`.
3. **Suporte:**
   - `replay-outbox` pelo CLI no container republicou o evento de autorização da NF-e;
   - estoque e recebíveis não mudaram;
   - a visão de suporte mostra fila vazia, nenhum resultado incerto, nada por entregar e
     as 6 tuplas ativas.

O simulador local roda com `timeout-after-accept` e 30 s entre tentativas. Por isso cada
emissão passou por resposta incerta e consulta, e a latência cai no balde de 30–60 s.

| Execução (UTC) | NF-e | Nº | Estoque (venda) | Recebíveis | Importação | Contas a pagar (Financeiro) | Ligadas na conciliação | Replay | Efeito do replay |
|---|---|---|---|---|---|---|---|---|---|
| 22:32 | `43129030-1b1b-4b0c-98fe-d1b515462e35` | 17 | −2 | 1 | conciliada | 1 | 1 | `simulation-authorized` | estoque 0, recebíveis 1 |
| 22:52 | `a04f7c64-82cf-4766-892d-5ec5329b378a` | 18 | −2 | 1 | conciliada | 1 | 1 | `simulation-authorized` | estoque 0, recebíveis 1 |
| 22:54 | `037e3050-83f2-4ef8-aef1-161a54ae6b64` | 20 | −2 | 1 | conciliada | 1 | 0 | `simulation-authorized` | estoque 0, recebíveis 1 |

Uma execução intermediária (NF-e nº 19) parou numa verificação do próprio golden path:
- ela exigia que a conciliação listasse a conta a pagar;
- essa lista é o retrato da projeção do Fiscal no momento da conciliação, e depende de o
  evento `financial.payable.posted` já ter chegado;
- o Financeiro tinha exatamente uma conta a pagar, como o smoke da fase 44 confere.

A verificação passou a só registrar o número (coluna "Ligadas na conciliação") e está nas
pendências abaixo.

### Fluxo de navegador

`web/scripts/fiscal-workflow.e2e.mjs`, Chromium headless, 22:55 UTC, operador fiscal do
workspace "Phase 39 validation":
1. **pt-BR, documentos:**
   - filtros NF-e 55 e "autorizado (simulado)";
   - diálogo com "Simulação — sem valor fiscal", 6 transições e as ações Cancelar e
     Carta de correção;
   - o cálculo cita regra e fonte;
   - o XML assinado baixado tem o digest mostrado na tela e `tpAmb` 2.
2. **XML de entrada:** NF-e de fornecedor gerada pelo CLI da fase 44 e enviada pelo
   formulário; o diálogo avisa que a situação na autoridade e a cadeia ICP-Brasil não são
   verificadas.
3. **Prévia de regras:** NFS-e 010101 de R$ 1.500,00, com explicação de ISS, CBS e IBS.
4. **Suporte:** aviso de ambiente só de simulação, linha `nfse-national-simulator-v1` na
   matriz, e Campinas (3509502) como "não suportado".
5. **Inglês:** o mesmo diálogo mostra "Simulation — no fiscal value".

Não houve erro de página. O golden path de navegador existente (`npm run test:browser`)
também passou depois da mudança na navegação.

### Ensaio de restauração

`scripts/phase48-restore-drill.sh`:
1. Dump do `horizon_fiscal` (`pg_dump` custom, SHA-256
   `225d1a5264157192cbe8afd5f422a4b070c76e2788f83dbdc75a606b7aa672f6`), restaurado num
   PostgreSQL novo com os papéis `horizon_owner` e `horizon_app`.
2. Cópia do volume cifrado do MinIO para um volume novo, servido por outro MinIO.
3. Um Fiscal apontando só para os dados restaurados:
   - vhost `phase48-restore` próprio no broker;
   - `FISCAL_SERVICE_KEYS_JSON={}`, então não emite nem publica.
4. `scripts/phase48-verify-restore.mjs` comparou com o Fiscal vivo:
   - NF-e 55: 3 autorizadas, 7 artefatos cada;
   - NFC-e 65: 1 autorizada e 2 canceladas, 7 e 11 artefatos;
   - NFS-e: 3 canceladas, 10, 5 e 10 artefatos.

   Resultado: **75 artefatos** com mesmo tipo, tamanho e SHA-256; outro tenant recebe
   404. Depois de reiniciar o Fiscal e o MinIO restaurados, o resultado se repetiu.

Os containers `horizon-phase48-restore-*`, o volume `horizon-phase48-restore-artifacts`
e o vhost ficaram para inspeção.

## Preparação local (fora do git)

- **Operador fiscal:** criado pela API do Identity no tenant "Phase 39 validation", que é
  o tenant servido pelo worker fiscal local: `fiscal.operator@horizon.local`, com a senha
  do demo e papéis admin de fiscal, sales, catalog, inventory, financial, procurement e
  parties. O usuário antigo desse tenant não tinha papel fiscal.
- **Stack local:**
  - Prometheus recriado com o volume de regras;
  - Fiscal reconstruído com a migração 0050;
  - web reconstruído.

## Pendências e limites

- **Homologação e produção** continuam como gate de ativação, pelos mesmos motivos das
  fases 43 a 47:
  - A1 da empresa;
  - WSDL e Swagger oficiais;
  - algoritmos de assinatura;
  - revisão fiscal.

  Nenhuma suíte de homologação roda, porque não há linha habilitada.
- **Expedição permitida pela autorização:** o Sales só exige autorização fiscal antes da
  expedição em depósitos com política de despacho, e essa política exige autorização de
  **produção**, que a simulação nunca produz. Em simulação, o golden path documenta a
  expedição já feita, como nas fases 42, 45 e 46. O bloqueio é coberto pelos testes do
  Sales (fase 43).
- **Contas a pagar ligadas na conciliação:** a lista de contas da conciliação é o retrato
  da projeção do Fiscal no commit. Quando o evento `financial.payable.posted` chega
  depois, a conciliação fica com a lista vazia, embora o Financeiro tenha a conta. Isso
  vem da fase 44; vale revisar se a leitura deve completar a ligação depois.
- **Canal de alertas:** o Prometheus avalia as regras, mas nenhum canal (e-mail, chat)
  está configurado. Limiares e canal são decisão do dono da implantação.
- **Retenção legal:** não foi fixado prazo. O runbook registra o que é guardado e que o
  prazo é definido e verificado pelo dono da implantação.
- **Prévia de regras:** uma linha por cenário, com as operações revisadas atuais.
  Cenários com várias linhas usam a API.
