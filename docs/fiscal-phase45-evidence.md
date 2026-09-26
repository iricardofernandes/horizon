# Fase 45 — evidências de devoluções, complementos e carta de correção

Status: **concluída em simulação em 2026-09-26**.
- Todos os documentos são NF-e modelo 55 autorizadas pelo simulador determinístico.
- A carta de correção foi registrada pelo mesmo simulador.
- Nenhuma autoridade foi consultada.
- Este registro não inclui XML integral, chave de acesso, certificado, chave privada ou
  dados pessoais.

Plano: [fiscal-phase45-implementation-plan.md](fiscal-phase45-implementation-plan.md).
Decisão: [ADR 0052](adr/0052-returns-and-complements-are-linked-documents.md).

## O que foi entregue

- **Catálogo de tipos** (`fiscal/src/document-kinds.ts`, `GET /fiscal/document-kinds`):
  - Suportados: venda, devolução de venda, devolução de compra e complemento de valor.
    Cada tipo declara `finNFe`, `tpNF`, a referência exigida, o fato de origem, o dono
    do estoque, o dono do dinheiro e a operação de capacidade.
  - Não suportados, cada um com o motivo: remessa e seu retorno, complemento de
    quantidade ou de imposto, ajuste, nota de crédito e nota de débito.
  - Fluxos de evento por modelo: o 55 tem cancelamento e carta de correção; 65 e NFS-e
    não têm nenhum.
- **Origens vinculadas** (`fiscal/src/linked-origins.ts`, `POST /fiscal/linked-origins`):
  - Snapshot selado e imutável, uma por fato de origem, qualquer que seja a chave.
  - `sale-return` pelo `shipmentId`: usa a devolução registrada por Vendas e referencia
    a venda autorizada da mesma expedição.
  - `purchase-return` pelo `receiptId` e pelo estabelecimento: usa a devolução
    projetada de Compras e referencia as NF-e do fornecedor conciliadas com o
    recebimento na fase 44.
  - `value-complement`: pedido revisado, com motivo, sobre uma venda autorizada.
- **Conservação:**
  - Cada linha vinculada guarda a linha original e a quantidade de referência.
  - A soma das origens não anuladas nunca passa da original (serviço com lock e
    gatilho no banco).
  - Uma origem só é anulada quando o último documento dela é cancelado.
- **Documentos vinculados:**
  - O rascunho vem da origem vinculada (`POST /fiscal/documents` com
    `origin.kind = 'linked'`).
  - A prontidão escolhe a capacidade da operação do tipo e o cálculo com propósito
    `return` ou `complementary`.
  - O XML leva `tpNF`, `finNFe` e `NFref`, com CFOP e natureza vindos do perfil
    revisado.
  - O complemento sai com `qCom` 0 e `vUnCom` 0, e `vProd` igual ao valor
    complementado.
  - Uma rejeição é corrigida por nova revisão da mesma origem vinculada.
- **Trava no cancelamento:** a original não pode ser cancelada enquanto uma origem
  vinculada viva ou uma carta de correção pendente apontar para ela (serviço e gatilho no
  comando). Uma recusa de cancelamento devolve o documento a `authorized` e guarda a
  resposta.
- **Carta de correção** (`POST/GET /fiscal/documents/:id/correction-letters`):
  - Evento 110110 assinado e validado no envelope do PL 010d.
  - O detalhe é conferido no código: descrição, texto de 15 a 1000 caracteres e a
    condição de uso fixa.
  - Exige o atestado de que a carta não muda valor, quantidade, partes ou datas.
  - A sequência vai de 1 a 20 e usa fila própria com a disciplina envio → incerto →
    consulta.
  - Nunca muda o status do documento.
- **Vínculos e correlação** (`GET /fiscal/documents/:id/links`):
  - Mostra referências, documentos vinculados, quantidades conservadas e os ids pelos
    quais Estoque e Financeiro registram os efeitos: `shipmentId` ou `receiptId`, e os
    estornos de contas a pagar que o Financeiro publicou.
  - O evento `fiscal.linked-document.simulation-outcome` leva o mesmo, sem chave de
    acesso nem XML.
- **Contratos** `@horizon/contracts` 0.34.0, fixados em todos os módulos:
  - esquemas de tipos, origens vinculadas, vínculos e carta de correção;
  - `complementValue` no cálculo;
  - origem `linked` e artefatos `correction_*`;
  - o evento novo.
- **Banco:** a migração `0047_phase45_linked_documents.sql` traz tabelas com RLS forçada,
  gatilhos de conservação, referência viva, carta e cancelamento, e a correção da chave
  da fase 44.
- **Rollout local:** `npm run phase45:rollout` importa, revisa e ativa as regras da fase
  45 e as três capacidades ao lado da venda ativa do estabelecimento.

## Critérios de saída

| Critério do roteiro | Evidência |
|---|---|
| Original e vinculados continuam legíveis | e2e `returns a Sales shipment…`: depois da devolução autorizada, a venda segue `authorized` com o mesmo XML assinado. O vínculo aparece nos dois sentidos. Cancelar a devolução anula a origem, e só então a venda pode ser cancelada. Uma recusa simulada devolve a venda a `authorized` e guarda `cancellation_response`. Stack local: venda, devolução e complemento autorizados, e o XML assinado da venda idêntico antes e depois. |
| Toda correção tem motivo | Revisão corrigida e complemento exigem motivo (≥ 10). A carta de correção exige texto (15 a 1000) e atestado. O cancelamento mantém a justificativa da fase 42. e2e `registers correction letters…`: sequências 1, 2 (incerta, depois consultada) e 3 (rejeitada). Mesma chave com outro texto é recusada, e a carta pendente trava o cancelamento. |
| Replay do histórico completo dá as mesmas quantidades e vínculos | e2e `replays the complete event history…`: reentrega com os mesmos ids (todos `duplicate`) e com ids novos (aplicados sem nova intenção). Os comandos são repetidos com a mesma chave e com outra. Contagens de intenções, origens, linhas, documentos e outbox inalteradas, e o digest do vínculo igual. |
| Devolução nunca passa da original | e2e `returns part of a purchase…`: devolução parcial de 2 de R1 e total de 4 de R2 contra a mesma linha da nota do fornecedor (2 + 4 ≤ 10). Um recebimento sem conciliação é recusado (`REFERENCE_INCOMPLETE`), e uma inserção direta de 5 além disso é recusada pelo gatilho. |
| Complemento registrado à parte | e2e `records a value complement…`: digests do cálculo e do XML da venda inalterados. O complemento sai com `finNFe` 2 e valor próprio. Complementar um documento vinculado é recusado (`REFERENCE_NOT_AUTHORIZED`). |
| Importação e cancelamento não duplicam estoque nem dinheiro | O outbox do Fiscal só tem eventos fiscais. Stack local: recebimento de 6 seguido da devolução e venda de 2 seguida da devolução deram delta total de estoque 0. O recebível foi cancelado pela devolução em Vendas, e a conta a pagar só foi estornada quando uma pessoa estornou no Financeiro. O Fiscal apenas passou a mostrar o id estornado. |
| Tipos não suportados não são emitidos | Unitário e e2e: remessa, ajuste, crédito e débito recusados. API: `kind: remittance` dá 400. Com a capacidade `value-complement` desativada, o rascunho do complemento fica em `draft` (`Fiscal capability is unsupported`). |

## Verificação (2026-09-26)

- Unitários do fiscal: 134 testes. Incluem catálogo e cálculo de devolução e complemento
  (4), XML de devolução e complemento validado no PL 010f (3), carta de correção no
  PL 010d (2) e rotas novas (4).
- e2e do fiscal com PostgreSQL real: 40 testes. São 6 novos da fase 45, e os 34 das
  fases 40 a 44 continuam passando.
- Contratos: 92 testes. Gate de compatibilidade da 0.33.0 para a 0.34.0: 0 quebras e 21
  adições.
- Também passaram:
  - pins (`@horizon/contracts@0.34.0` em todos os módulos);
  - links da documentação;
  - os 21 testes de scripts;
  - `make check` em todos os projetos.

### Smoke no stack local via Kong

`scripts/phase45-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`. Antes, o
Fiscal foi reconstruído com a migração 0047, `phase45:rollout` foi aplicado e o perfil
de emissão ganhou o mapa `linked`. Passos:
1. **Compras:**
   - fornecedor novo;
   - pedido de 10 e recebimento de 6;
   - conta a pagar lançada;
   - NF-e do fornecedor importada e conciliada.
2. **Devolução de compra:**
   - antes da devolução em Compras, `SOURCE_NOT_PROJECTED`;
   - depois dela, NF-e de devolução com `tpNF` 1, `finNFe` 4, CFOP 5202 e o CNPJ do
     fornecedor como destinatário;
   - o estorno manual da conta a pagar aparece na correlação.
3. **Vendas:**
   - cliente novo;
   - pedido de 2 confirmado, separado, embalado e expedido;
   - NF-e de venda autorizada a partir da origem de Vendas;
   - devolução da expedição em Vendas e NF-e de devolução com `tpNF` 0, `finNFe` 4 e
     `refNFe` da venda.
4. **Na venda:**
   - complemento de R$ 1,50 (`qCom` 0, `vProd` 1.50);
   - carta de correção registrada;
   - cancelamento recusado com `CANCELLATION_NOT_ALLOWED`.

O simulador local roda com `timeout-after-accept`, então toda emissão, cancelamento e
carta passou por resposta incerta e consulta.

| Execução | Venda | Devolução de venda | Complemento | Devolução de compra |
|---|---|---|---|---|
| 19:03 UTC | `ae3b963c-615d-422d-9339-bac7327e0bcc` | `da53bf72-b49d-4203-97da-73e5aeabfc24` | `274f78bf-278f-4ea3-b03b-d99643bc35d4` | `0859b14c-dd6f-4b3b-86ee-75e2c498274f` |
| 19:08 UTC | `54ea3e16-fdeb-4898-87e3-d2ae7b6f2b5d` | `623d82cd-2f1a-4d4b-8fc0-7aae07e65ac1` | `2165e4f0-0065-4079-8b4a-3a8ff002d81c` | `04194211-6403-457a-967f-8c8c803114a2` |

Houve três execuções, todas aprovadas. Na primeira (ids não registrados) e na de 19:03
a conta a pagar ficou `posted` e a correlação financeira veio vazia, o que levou à etapa
de estorno manual; na de 19:08 o estorno aparece na correlação. Em todas:
- delta de estoque do recebimento +6 e delta total 0;
- o recebível do cliente cancelado por Vendas e Financeiro;
- uma única conta a pagar por recebimento.

O outbox entregou um `fiscal.linked-document.simulation-outcome` por documento vinculado
(9 nas três execuções), e as 3 cartas foram resolvidas.

## Achados durante a fase

- **Chave da conciliação da fase 44.** Uma linha de nota não podia ser alocada a dois
  recebimentos parciais da mesma linha de pedido. A checagem do serviço e a chave
  primária usavam só `(linha da nota, linha do pedido)`. As duas agora incluem o
  recebimento; a migração 0047 troca a chave primária.
- **Pedido de devolução de venda.** O operador conhece a expedição, não a intenção
  interna. O pedido usa `shipmentId`, e a devolução de compra leva o estabelecimento
  emissor, porque o recebimento não o informa.
- **Financeiro e devolução.** O Financeiro só retira a conta a pagar em rascunho. Uma
  conta já lançada fica para estorno manual, e o Fiscal não finge que ela foi estornada.

## Limites conhecidos

- Homologação e produção de documentos vinculados e de cartas de correção, operações
  interestaduais e regras fora de SP não estão cobertas. Cada uma exige a própria linha
  de capacidade.
- As listagens `/capabilities` e `/capabilities/v2` continuam mostrando só a venda, pois
  seus esquemas fixam a operação `normal-sale`. Os tipos e o estado deles aparecem no
  catálogo, e uma listagem nova fica para as telas da fase 48.
- A devolução de compra usa unidades e preços do comprador, e não o código e a unidade
  do fornecedor.
- A origem de Vendas de uma expedição ainda é localizada pelo banco no smoke; não há
  rota de leitura das intenções.
- Uma devolução cancelada libera as quantidades, mas não pode ser reemitida sem um novo
  fato de origem.
- A interpretação de tributos, CFOP e natureza foi aprovada provisoriamente para
  simulação. A revisão fiscal completa fica para o fim do programa fiscal.
