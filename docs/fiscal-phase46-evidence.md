# Fase 46 — evidências da NFC-e modelo 65

Status: **concluída em simulação em 2026-09-26**.
- Toda NFC-e desta fase foi autorizada pelo simulador determinístico do modelo 65.
- Nenhuma autoridade foi consultada.
- As URLs de QR code e de consulta apontam para `nfce.simulacao.horizon.invalid`, que
  nunca resolve.
- Este registro não inclui XML integral, chave de acesso, CPF, certificado ou chave
  privada.

Plano: [fiscal-phase46-implementation-plan.md](fiscal-phase46-implementation-plan.md).
Decisão: [ADR 0053](adr/0053-nfce-is-a-separate-model-over-the-sales-shipment.md).
Fontes: [manifesto da fase 46](fiscal-phase46-source-manifest.json) (NT 2025.001 v1.02 e
manual do DANFE NFC-e v6.0, com SHA-256).

## O que foi entregue

- **Origem:** a mesma expedição de Vendas (`sales.fiscal-origin.recorded`, propósito
  `original`), com `model: '65'` no pedido de rascunho (versão 2). Estoque e recebível
  continuam sendo os da expedição.
- **Uma venda, um modelo:**
  - o primeiro documento de uma intenção fixa o modelo;
  - o serviço e um gatilho recusam o outro modelo (`MODEL_CONFLICT`), inclusive para
    sucessores;
  - o índice parcial segue garantindo um documento vivo por intenção.
- **Elegibilidade:** consumidor final não contribuinte, na mesma UF do emitente, e
  capacidade ativa do modelo 65 (`consumer-sale`, fixture
  `rtc-v0057-model65-consumer-sale-sp-2026-01`). Fora disso, `CONSUMER_NOT_ELIGIBLE` ou
  `CAPABILITY_UNSUPPORTED`.
- **Construtor próprio** (`fiscal/src/nfce65/`):
  - `ide` com `mod` 65, `tpImp` 4, `indFinal` 1, `idDest` 1 e `indPres` do perfil
    revisado (4 = entrega, com `indIntermed` 0);
  - `dest` com CPF ou CNPJ, nome, endereço e `indIEDest` 9, sem IE;
  - `pag` com indicador e meio do perfil, e `vPag` igual ao `vNF`;
  - `infNFeSupl` antes da assinatura, fora da referência assinada.

  Só o algoritmo da chave, a validação no PL 010f, a assinatura XML-DSig e os grupos de
  item, IBS/CBS e totais são comuns ao modelo 55.
- **QR code versão 3 online:** `<url>?p=<chave>|3|<tpAmb>`, sem CSC, conforme NT
  2025.001 §04 e o padrão do XSD.
- **DANFE NFC-e:** PDF de 80 mm com as divisões I a IX do manual v6.0:
  - QR de 28 mm com zona de silêncio de 3,5 mm, nível M;
  - "CONSUMIDOR CPF:" ou "CONSUMIDOR NÃO IDENTIFICADO";
  - protocolo e data de autorização no horário local;
  - "EMITIDA EM AMBIENTE DE SIMULAÇÃO – SEM VALOR FISCAL";
  - uma prévia diz "NÃO AUTORIZADA".
- **`dhEmi`:** é o instante da assinatura. Emitir em outro dia que o do cálculo travado
  é recusado (`READINESS_STALE`). Uma nova tentativa reaproveita os bytes já vinculados.
- **Autoridade simulada do modelo 65:**
  - autorização síncrona;
  - resultado pela identidade do comando;
  - rejeição (`SIMULATED_LATE_EMISSION`) quando recebe a nota pela primeira vez mais de
    5 minutos depois do `dhEmi` (NT 2025.001 §02.4);
  - `authorizedAt` no protocolo.
- **Cancelamento (110111):** é o único fluxo de evento do modelo 65. Só vale dentro da
  janela revisada, contada do protocolo; depois dela, `CANCELLATION_WINDOW_ELAPSED`.
  Carta de correção, devolução e complemento de NFC-e são recusados.
- **Evento:** `fiscal.consumer-document.simulation-outcome` v1 (autorizada, rejeitada ou
  cancelada), com a expedição e os donos dos efeitos. Não leva chave, QR, XML nem dados
  do consumidor. Os eventos do modelo 55 não mudaram.
- **Contratos** `@horizon/contracts` 0.35.0, fixados em todos os módulos. Nenhum esquema
  publicado foi alterado; os que precisavam aceitar o modelo 65 ganharam versão nova:
  - pedido de criação v2;
  - leitura do documento v3;
  - documento pronto v2;
  - catálogo de tipos v2;
  - códigos de problema do modelo 65.
- **Banco:** migração `0048_phase46_nfce.sql`:
  - o modelo 65 só nasce de uma intenção de Vendas;
  - o gatilho fixa o modelo por intenção;
  - a referência de devolução e complemento passa a exigir modelo 55.
- **Rollout local:** `npm run phase46:rollout` importa, revisa e ativa as regras do
  modelo 65 e a linha de capacidade, e imprime o bloco `consumer` do perfil de emissão.

## Critérios de saída

| Critério do roteiro | Evidência |
|---|---|
| XSD próprio do modelo 65 | Unitário `nfce65/xml.spec.ts`: XML assinado validado no PL 010f, com e sem consumidor. Chave do modelo 55, contingência, QR de outra chave, entrega sem endereço e pagamento diferente do total são recusados. A assinatura cobre só `infNFe` e fica depois de `infNFeSupl`. |
| QR e renderização | Unitário `nfce65/danfe.spec.ts`: os módulos desenhados no PDF são remontados e decodificados (jsQR) e dão exatamente o `qrCode` do XML. Os textos de cada divisão estão no conteúdo da página. A página tem 80 mm. |
| Venda duplicada | e2e `keeps one sale to one model…`: reentrega da origem de Vendas (não aplicada), rascunho repetido com a mesma chave e sem chave (mesmo id), o modelo 55 para a mesma intenção recusado pelo serviço e por inserção direta (gatilho). Depois da autorização, rodar o worker de novo não gera outro evento. |
| Indisponibilidade | e2e `consults after an outage…`: a primeira remessa fica `unknown`. A tentativa seguinte consulta a chave antes de reenviar e, 6 minutos depois do `dhEmi`, recebe `SIMULATED_LATE_EMISSION`. Observações: `unknown` e depois `rejected`. O sucessor (revisão 2, número 2, chave nova) é autorizado, e só ele fica `authorized` na intenção. |
| Cancelamento | e2e `cancels inside the window…`: cancelada dentro da janela, com o evento `cancelled`. Uma recusa simulada mantém a NFC-e `authorized` e guarda `cancellation_response`. Depois de 32 minutos, `CancellationWindowElapsed`. |
| Uma venda, um efeito de estoque e dinheiro | O outbox do Fiscal só tem eventos `fiscal.*`. Stack local: duas expedições de 2 deram delta de estoque -4, e cancelar a NFC-e não devolveu nada. Há um único recebível para a consumidora. |
| Testes do modelo 55 inalterados e verdes | Os 40 e2e das fases 40 a 45 passam. Nenhum arquivo de teste do modelo 55 foi editado para mudar uma expectativa. O rascunho do modelo 65 para uma intenção já com NF-e continua a responder "Conflicting fiscal draft", como o e2e da fase 40 exige. |
| Matriz de suporte exata | [fiscal-capabilities.md](fiscal-capabilities.md): NFC-e 65, simulação, SP, `consumer-sale`, `nfce65-simulator-v1`. Homologação e produção do 65, venda de balcão e contingência offline seguem `unsupported`. |

## Verificação (2026-09-26)

- Unitários do fiscal: 149 testes. Os 15 novos cobrem:
  - XML, QR e assinatura (5);
  - DANFE NFC-e (4);
  - simulador (4);
  - rotas do modelo 65 (2).

  O catálogo de tipos também ganhou asserções.
- e2e do fiscal com PostgreSQL real: 45 testes, sendo 5 novos da fase 46.
- Contratos: 96 testes. Gate de compatibilidade da 0.34.0 para a 0.35.0: 0 quebras e 12
  adições.
- Também passaram:
  - pins (`@horizon/contracts@0.35.0` em todos os módulos);
  - links da documentação;
  - `make check` em todos os projetos.

### Smoke no stack local via Kong

`scripts/phase46-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`.
Preparação:
- o Fiscal foi reconstruído com a migração 0048;
- `phase46:rollout` foi aplicado, com a evidência igual ao SHA-256 do e2e da fase 46;
- o perfil de emissão ganhou o bloco `consumer`.

Passos:
1. **Catálogo:** `consumer-sale` suportado no modelo 65; `counter-sale` e
   `consumer-sale-offline` recusados; o fluxo de evento do 65 é `cancellation`.
2. **Venda a consumidor:**
   - pessoa com CPF, consumidora final não contribuinte;
   - pedido de 2 confirmado, separado, embalado e expedido;
   - rascunho modelo 65 repetido com a mesma chave (mesmo id);
   - modelo 55 para a mesma intenção recusado (`MODEL_CONFLICT`).
3. **NFC-e autorizada:**
   - o XML tem `mod` 65, `tpImp` 4, `indFinal` 1, `indIEDest` 9, o CPF e `tPag` 05;
   - o QR é `https://nfce.simulacao.horizon.invalid/qrcode?p=<chave>|3|2`;
   - o DANFE NFC-e autorizado é um PDF de 226,77 pt (80 mm) de largura.
4. **Contribuinte:** empresa com IE, expedição e rascunho modelo 65; a validação dá 422
   `CONSUMER_NOT_ELIGIBLE`.
5. **Cancelamento** da NFC-e dentro da janela: `cancelled`.

O simulador local roda com `timeout-after-accept`, então cada emissão e cancelamento
passou por resposta incerta e consulta.

| Execução | NFC-e | Número | Cancelamento | Contribuinte | Delta de estoque | Eventos |
|---|---|---|---|---|---|---|
| 19:50 UTC | `d2863cb4-69d1-473a-9862-e55250fff271` | 2 | `cancelled` | `CONSUMER_NOT_ELIGIBLE` | -4 | autorizada, cancelada |
| 19:52 UTC | `49b3e027-79af-40b3-bc4e-a4af25947b9f` | 3 | `cancelled` | `CONSUMER_NOT_ELIGIBLE` | -4 | autorizada, cancelada |
| 19:53 UTC | `d3eaaa21-9044-4bdb-b894-e34c305e95ed` | 4 | `cancelled` | `CONSUMER_NOT_ELIGIBLE` | -4 | autorizada, cancelada |

Uma execução anterior parou numa verificação do próprio smoke: o título do PDF é
gravado em hexadecimal, então a busca pelo texto falhou. Ela deixou a NFC-e número 1
autorizada, sem cancelamento. A verificação passou a conferir a largura da página. O
outbox entregou os 7 eventos `fiscal.consumer-document.simulation-outcome` das quatro
execuções.

## Achados durante a fase

- **Esquemas publicados.** Trocar o literal `'55'` por `'55' | '65'` nos esquemas v1
  foi apontado pelo gate como 7 quebras. Conforme a ADR 0030, esses esquemas ficaram
  intactos e ganharam versões novas. A rota `/documents/:id/v2` passa a responder no
  esquema v3, que um documento do modelo 55 continua satisfazendo.
- **Mensagem de conflito.** O e2e da fase 40 espera "Conflicting fiscal draft" quando a
  mesma intenção pede outro modelo. O novo erro `MODEL_CONFLICT` mantém esse prefixo, e
  a API o mapeia pelo tipo do erro.
- **Código comum.** O cálculo de linhas e totais saiu de `issuance.ts` para
  `nfe-lines.ts` e `nfe-values.ts`, usados pelos dois modelos. A saída do modelo 55 não
  mudou: o digest fixado no teste de XML do 55 continua igual.

## Limites conhecidos

- **Homologação e produção do modelo 65** não foram feitas, por instrução do dono do
  ambiente (só simulação). Elas exigem:
  - as URLs ENCAT de QR e consulta da UF;
  - os endpoints do autorizador NFC-e;
  - um emitente com certificado A1 real;
  - a janela legal de cancelamento da UF;
  - revisão Fiscal.
- **Venda de balcão:** não há fato de Vendas com a forma de pagamento nem entrega de
  estoque para ela. A NFC-e sai de uma expedição, com pagamento "crédito loja" (05) a
  prazo, porque a expedição lança um recebível.
- **Contingência offline** (`tpEmis` 9, QR v3 com assinatura) e EPEC não foram
  implementadas: o manual de contingência (MOC Anexo IV) não foi fixado.
- **Tributos no DANFE:** a mensagem da Lei 12.741 (divisão IX) não é impressa: o
  cálculo não produz o valor aproximado de tributos que ela exige.
- **Leitura de capacidades:** as rotas `/capabilities` continuam listando só a venda do
  modelo 55; o suporte do modelo 65 aparece no catálogo de tipos v2.
- **Intenção por expedição:** o smoke ainda localiza pelo banco a intenção de Vendas de
  uma expedição.
- **Interpretação provisória:** presença, pagamento, janela de 30 minutos e tributos do
  modelo 65 foram aprovados provisoriamente para simulação. A revisão fiscal completa
  fica para o fim do programa fiscal.
