# Fase 49 — evidências das linhas de serviço e das decisões de serviços

Status: **concluída em 2026-09-26** (execuções locais entre 00:37 e 00:42 UTC de 27/09).
Plano: [services-phase49-implementation-plan.md](services-phase49-implementation-plan.md).
Decisão: [ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md).

## O que foi entregue

- **ADR 0056**, com as decisões da fase K:
  - serviços ficam dentro de `sales/`;
  - o pedido de venda é só de mercadorias, e o serviço é entregue por ordem de serviço;
  - um dono por efeito: Sales, Financeiro e Fiscal; o Inventory nunca é consultado para
    serviço;
  - identidade única do serviço cobrado (documento + mês de competência), usada como
    chave de origem no Fiscal e documento de origem no Financeiro;
  - política de emissão da NFS-e por estabelecimento.

  O plano da fase K foi atualizado com essa revisão.
- **Sales:**
  - migração `0011_catalog_item_kind`: a projeção de itens guarda o `kind` do Catalog
    (`product` ou `service`). Uma repetição do evento nunca muda um tipo já gravado;
  - comando `npm run backfill:item-kinds`: preenche uma única vez, pela API do Catalog, o
    tipo dos itens projetados antes, e grava auditoria;
  - regra de domínio `goodsOnly`, aplicada antes de qualquer evento. Criar pedido com
    serviço e converter proposta aceita com serviço são recusados (`409`), com o motivo e
    as linhas. A recusa desfaz a transação inteira, então a proposta continua aceita e sem
    pedido;
  - leituras de orçamento e pedido com `kind` em cada linha;
  - item de tipo desconhecido continua tratado como mercadoria.
- **Defeito corrigido no Sales:**
  - antes, se `catalog.price.changed` chegasse antes de `catalog.item.created`, o preço
    se perdia, porque o `UPDATE` não achava a linha. O smoke local mostrou isso na
    segunda execução;
  - agora o preço cria a linha com descrição provisória, que o evento do item substitui.
    Há um e2e para a ordem invertida.
- **Web:**
  - a proposta marca os serviços nas opções e nas linhas ("Serviço");
  - o formulário de pedido oferece só mercadorias;
  - uma proposta aceita com serviços mostra um aviso no lugar de "Converter";
  - nova tela **Fiscal → Perfis de serviço** (`/app/fiscal/service-profiles`), com a
    revisão em vigor e a próxima de cada serviço do Catálogo, o histórico e a criação de
    revisão por administrador fiscal;
  - datas no dia local do navegador;
  - mensagens em pt-BR e en.

Não houve mudança em `@horizon/contracts`: os eventos de orçamento não levam linhas, e os
eventos de pedido não mudaram.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Decisões registradas antes do código de serviço | ADR 0056 e plano da fase K revisto |
| Serviço nunca chega ao Inventory | testes de domínio de `goodsOnly`; e2e: pedido e conversão recusados sem `sales.order.placed` no outbox; smoke: contagem de `sales.order.placed` igual antes e depois das recusas |
| Caminho de mercadorias inalterado | e2e anteriores do Sales sem alteração; smoke: pedido de mercadoria confirmado, separado, embalado e despachado; golden path de navegador existente passando |
| Tipo conhecido para itens antigos e novos | e2e de projeção, repetição e backfill; backfill local (abaixo) |
| Perfil fiscal de serviço mantido por uma pessoa | fluxo de navegador cria uma revisão (01.01.01 digitado, 010101 gravado) e lê o histórico |

## Verificação

- **Sales:**
  - 75 testes unitários, sendo 3 novos (`goodsOnly`);
  - e2e com PostgreSQL: 18 passando, sendo 5 novos:
    - projeção do tipo e repetição do evento;
    - recusa do pedido com serviço;
    - proposta mista legível e não convertida;
    - backfill;
    - preço antes do item.
- **Web:**
  - 50 testes unitários, sendo novos os de `hasServiceLines`, `goodsOnly`, `profileOn`,
    `profileRequest` e `localToday`;
  - lint, cópia sem texto inline, typecheck e build ok.
- **Jobs isolados reproduzidos** (checkout só do módulo, contratos vindos de registro
  descartável):
  - Sales: typecheck, lint, 75 testes e build;
  - web: typecheck, lint, 50 testes e build.
- **CI local (`make ci-local`):** todas as etapas passaram:
  - fronteiras, pins, compatibilidade de contratos, links, referências de actions, guarda
    do Terraform e varredura de segredos;
  - typecheck, lint, testes e build de todos os projetos;
  - e2e de todos os serviços;
  - arquivos gerados sem mudança.

### Backfill no stack local

`node dist/main/backfill-item-kinds.js`, rodado no container do Sales, duas vezes por
tenant:

| Tenant | Desconhecidos antes | Preenchidos | Segunda execução |
|---|---|---|---|
| `01a0c5f8…` (Phase 39 validation) | 4 | 1 mercadoria e 3 serviços | 0 alterações |
| `01a0b6b8…` (Horizon Demo) | 1 | 1 mercadoria | 0 alterações |

### Smoke no stack local

`scripts/phase49-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`, três
execuções. Cada uma:
1. Cria um serviço com preço no Catalog (R$ 1.500,00) e espera o Sales projetá-lo como
   `service`.
2. Cria uma proposta com uma mercadoria e o serviço (total R$ 1.512,50), envia e aceita.
   As linhas voltam com `product` e `service`.
3. Tenta converter a proposta: `409` "service lines of a proposal are delivered by a
   service order…", com a linha do serviço. A proposta continua `accepted` e sem pedido.
4. Tenta criar pedido com o serviço: `409`. Nenhum `sales.order.placed` novo.
5. Cria pedido de mercadoria, que é confirmado pela reserva, separado, embalado e
   despachado.

| Execução (UTC) | Serviço | Proposta | Pedido de mercadoria | Expedição |
|---|---|---|---|---|
| 00:39 | `01a0e04d-b4b7-7fe2-b47c-3b55a6640116` | `01a0e04d-b922-71d4-a5bc-0dcee8cfa154` | `01a0e04d-b980-7639-a6d1-7238322d4002` | `01a0e04d-c167-7b3d-aab2-38e90b5d62bf` |
| 00:39 | `01a0e04d-c1c2-7981-8f79-c2c154561c58` | `01a0e04d-c625-7236-99fa-50dd20b525e1` | `01a0e04d-c673-7de5-b6f9-71598625bafc` | `01a0e04d-ce58-7b13-a32a-32d886d5d9af` |
| 00:39 | `01a0e04d-ceac-7cdb-aef1-a8731b5d681b` | `01a0e04d-d310-726d-a544-49848625a9b8` | `01a0e04d-d35f-7bae-8d24-704079b09588` | `01a0e04d-db43-713d-9ac2-8ab3e04ed3f8` |

### Navegador

`web/scripts/fiscal-workflow.e2e.mjs` às 00:41 UTC, com as etapas da fase 48 e duas novas:
- **perfil de serviço:** abre "Implantação assistida", grava uma revisão com o código
  digitado com pontos e confere 010101 e 115022000 no histórico;
- **proposta:** no "Novo orçamento", o item de serviço aparece como "… · Serviço".

O golden path de navegador existente (`npm run test:browser`) também passou.

## Pendências e limites

- A ordem de serviço, com conversão da proposta, etapas, entrega, recebível e NFS-e, é a
  fase 50. Até lá, uma proposta aceita com serviços fica aceita e a tela explica por quê.
- **Janela transitória:** entre a chegada do preço e a do item, o Sales pode ter um item
  com descrição provisória e tipo desconhecido, tratado como mercadoria. A janela dura
  milissegundos no stack local; a repetição do evento do item a fecha.
- A resposta de conflito do Sales segue o formato padrão do Nest (`message`), não
  RFC 9457 (`detail`). O web já lê os dois. Isso é anterior a esta fase.
