# Fase 58 — evidências: conversão em orçamento e atribuição

Status: **concluída em 2026-09-27** (execuções locais entre 17:00 e 17:30 UTC).
Plano: [crm-phase58-implementation-plan.md](crm-phase58-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **Contratos 0.45.0:**
  - `sales.quote.sent`, `accepted` e `rejected` ganham `attribution` opcional
    (`opportunityId`, `ownerId`, `sourceId`). É uma mudança aditiva, e o gate de
    compatibilidade a classifica assim;
  - `crm.opportunity.converted` (v1);
  - todos os módulos fixados em 0.45.0.
- **Sales:**
  - projeta as oportunidades a partir de `crm.opportunity.*`, campo a campo: owner, origem
    e status guardam o instante do fato que os definiu, e um fato mais antigo nunca
    sobrescreve um mais novo;
  - `POST /quotes` aceita `opportunityId`. A oportunidade precisa ser conhecida, estar
    aberta e ser do mesmo cliente;
  - o owner e a origem são lidos da projeção e congelados na primeira versão. Toda versão
    seguinte e todo evento de orçamento os levam;
  - o schema da requisição é estrito: um corpo com `ownerId`, `sourceId` ou `attribution`
    recebe `400`;
  - migração `0016_opportunity_attribution`: `opportunity_projections` com RLS forçado e as
    colunas de atribuição em `quotes`, com um check (tudo nulo ou tudo preenchido).
- **CRM:**
  - consome `sales.quote.*` que tragam atribuição e mantém `opportunity_quotes`: a versão
    mais nova de cada oferta e o que aconteceu com ela;
  - um orçamento aceito converte a oportunidade com o fato `converted`: ganha no total do
    orçamento, com o orçamento registrado. Isso vale para oportunidade aberta, perdida (a
    perda fica no histórico) ou ganha à mão (mantém a data);
  - publica `won` (quando ainda não estava ganha) e `converted`;
  - a conversão acontece uma vez só, e uma oportunidade convertida não pode ser reaberta;
  - migração `0003_quote_conversion`: colunas da conversão com check, `converted` no check
    do histórico, e `opportunity_quotes` com RLS forçado.
- **Sequência "converter em orçamento":** conceder `customer` no Parties, esperar o
  cliente no Sales e escrever o orçamento com `opportunityId`. O smoke roda a sequência
  pelo Kong; a tela da fase 60 vai usar a mesma.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Conta → contato → oportunidade → orçamento → orçamento aceito mantém origem e owner em cada passo, inclusive numa versão renegociada | unitário e e2e do Sales: v1 e v2 com a mesma atribuição, mesmo depois de a oportunidade trocar de owner; os três eventos de orçamento com a atribuição. Smoke: prospect → contato → oportunidade com origem → cliente → orçamento v1 enviado → troca de owner → v2 enviada e aceita; as duas versões e os três eventos com o owner e a origem da primeira versão; `converted` com a origem e o total |
| Um evento de orçamento repetido não fecha a oportunidade duas vezes | unitário: o mesmo `accepted` duas vezes, com outro `eventId` e de outra oferta, e um único `converted`. e2e: entregas concorrentes e repetidas no PostgreSQL, com histórico `created, converted`, um `won` e um `converted` no outbox, e o histórico reconstruindo a linha |
| O CRM não escreve no Sales, e o Sales não aceita atribuição vinda do corpo | o CRM não tem URL nem credencial do Sales e só consome eventos; o Sales só lê owner e origem da própria projeção. Smoke: corpo com `ownerId` → `400` |

## Smoke no stack local

`node scripts/phase58-smoke.mjs` (tenant de demonstração), depois de `make up-apps`.
Uma fila de prova ligada a `sales.quote.#` e `crm.opportunity.#` é criada e removida pelo
script.

| Verificação | Resultado |
|---|---|
| Prospect sem documento, contato, origem, funil, oportunidade | criados; o Sales projeta a oportunidade como `open` |
| Orçamento antes de o prospect virar cliente | `404` (cliente não encontrado) |
| Contatos preenchidos e `customer` concedido no Parties | o Sales lista o cliente |
| Orçamento com `ownerId` no corpo | `400` |
| Orçamento v1 com `opportunityId`, enviado | atribuição com owner e origem |
| Troca de owner no CRM, v2 renegociada, enviada e aceita | v2 com a mesma atribuição da v1 |
| Oportunidade | `won`, conversão com `quoteRoot` = v1 e `quoteVersion` 2, valor = total da v2, histórico `created, owner-changed, converted` |
| Reabrir | `409` |
| RabbitMQ | `sales.quote.sent` ×2 e `accepted` com a atribuição; `crm.opportunity.created, owner-changed, won, converted` |

O primeiro `make up-apps` falhou no build do `treasury` (SIGBUS no `npm ci`, durante 13
builds em paralelo, com disco e memória folgados). O segundo passou sem mudança nenhuma.
Nenhuma mensagem nova nas DLQs veio dos consumidores `crm.events` e `sales.events`.

## Verificação

- **Sales:**
  - 124 testes unitários (4 novos: atribuição, recusas, orçamento sem oportunidade e
    projeção fora de ordem);
  - e2e com PostgreSQL: 27 testes, 2 novos em `test/attribution.e2e-spec.ts`.
- **CRM:**
  - 79 testes unitários (7 novos em `quote-conversion.spec.ts`);
  - e2e: 22 testes, 3 novos em `test/conversion.e2e-spec.ts`.
- **Contratos:** 118 testes (3 novos).
- **`make check`:** passou.
- **CI local (`make ci-local`):** passou em todas as etapas, rodado depois de este arquivo
  existir ("Local code and integration gates passed").
- **Jobs isolados:** `crm` (79 testes e build) e `sales` (124 testes e build) passaram
  com um registro descartável e os contratos 0.45.0 publicados a partir da árvore de
  trabalho.
