# Fase 54 — evidências: Parties sem documento brasileiro e decisões do CRM

Status: **concluída em 2026-09-27** (execuções locais entre 13:50 e 15:10 UTC).
Plano: [crm-phase54-implementation-plan.md](crm-phase54-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **ADR 0057**, com duas partes:
  - **documento tipado da Party:** `cpf`, `cnpj`, `foreign` (país e identificador) ou
    `none`. Os contatos passam a ser exigidos conforme o papel. Um documento `none` pode
    ser informado depois, uma única vez. Perfil fiscal só com CPF/CNPJ. Há aviso de
    duplicata e eventos v2;
  - **fronteira do CRM** (fases 55–60): módulo próprio; conta é Party; contato pertence ao
    CRM; o CRM nunca escreve no Sales; métricas vêm do histórico.
- **Contratos 0.41.0:**
  - `parties.party.registered` v2 e `parties.party.updated` v2, com `documentType`,
    `documentCountry` e contatos anuláveis. O número do documento nunca vai no evento;
  - todos os módulos fixados em 0.41.0 e publicados no Verdaccio local.
- **Parties:**
  - `PartyDocument` substitui `TaxId`. O atalho `taxId` continua aceito na API, então os
    clientes antigos (scripts, smokes, demo) não mudaram;
  - regra de contatos por papel: `customer`, `supplier` e `carrier` exigem e-mail,
    telefone e endereço, na criação, na concessão do papel e na edição;
  - `PUT /parties/{id}/document` informa o documento de quem estava sem nenhum, uma vez;
  - `POST /parties/duplicate-check` compara nome, e-mail, telefone e documento
    normalizados, por índices cegos com chave;
  - perfil fiscal recusado (`409`) para `foreign` e `none`;
  - migração `0002_party_documents`: `document_type` derivado do `kind` (sem abrir texto
    cifrado), colunas anuláveis, checks de coerência e índices de busca;
  - `npm run backfill:party-lookups -- --tenant <uuid>`, idempotente.
- **Consumidores** (Sales, Compras, Financeiro):
  - aceitam v1 (repetições) e v2;
  - quem não é cliente (ou fornecedor) nem foi projetado antes é ignorado antes de
    qualquer validação;
  - um contato que chega nulo para um ex-cliente ou ex-fornecedor mantém o valor
    conhecido. A regra fica na entidade (`Customer.refresh` e `Supplier.refresh`).
- **Web:**
  - formulário de cadastro compartilhado entre Pessoas e empresas e Clientes: tipo de
    documento, país, tipo de pessoa, contatos obrigatórios só quando o papel exige, e aviso
    de duplicata com "Cadastrar mesmo assim";
  - ação "Informar documento" na lista;
  - documento mascarado com o país ("DE •••• PBLT") ou "Sem documento";
  - mensagens em pt-BR e en.
- **Dois defeitos de tela corrigidos:**
  - o popup do select abria **por baixo** dos diálogos (`z-index` 20 contra 31). Quem usava
    mouse não conseguia escolher uma opção em nenhum select dentro de diálogo (armadilha
    11 da fase K). Agora o popup fica em 40;
  - numa grade de duas colunas, o campo ao lado de um campo com texto de ajuda esticava
    (`.ui-field` sem `align-content: start`).
- **Demo e golden path:**
  - `scripts/demo.mjs` procura as parties por `findByDocument`;
  - o golden path de navegador agora passa pelo aviso de duplicata antes do erro de CPF
    inválido.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Estrangeiro e pessoa sem CPF viram clientes e recebem orçamento | smoke: os dois projetados no Sales e com orçamento `sent`; e2e do Financeiro: título a receber para cliente estrangeiro vindo de evento v2 |
| Prospect só com nome, achado pela checagem de duplicata | smoke: `byName = 1` (`ACME COMERCIO` acha `Acme Comércio Ltda.`); navegador pt-BR: aviso exibido e "Cadastrar mesmo assim" |
| Parties existentes mantêm id e documento | stack local: as 60 parties tipadas pela migração (55 `cnpj`, 5 `cpf`), índices de documento inalterados; demo e golden path encontram as mesmas parties |
| Evento v1 e v2 com os mesmos dados dão a mesma projeção | unitário do Sales (`projects the same customer from a v1 replay and a v2 event`); e2e de Compras (fornecedor estrangeiro v2 igual ao v1) |
| Caminho de mercadorias inalterado | `make demo` e golden path de navegador passando |

## Smoke no stack local

`node scripts/phase54-smoke.mjs` (tenant de demonstração), depois de `make up-apps`:

| Verificação | Resultado |
|---|---|
| Cliente estrangeiro (`US`, EIN) e cliente sem documento | cadastrados; `document` = `{ type: 'foreign', country: 'US', suffix }` e `none` |
| Mesmo documento estrangeiro, outra caixa | `409` |
| Cliente sem contatos | `400` — "a customer needs email, phone, address" |
| Prospect só com nome | cadastrado; não aparece nos clientes do Sales |
| Checagem por nome e por documento | uma correspondência cada, com `matchedOn` `['name']` e `['document']` |
| Eventos no outbox | `2:foreign:US`, `2:none`, `2:none`; o número do documento não aparece em nenhum payload |
| Orçamento aos dois clientes | ambos `sent` |
| Perfil fiscal para o estrangeiro | `409` — "a fiscal profile needs a CPF or CNPJ…" |
| Informar documento do prospect | `cnpj` gravado; segunda vez `409` |
| Conceder `customer` sem contatos | `409` — "…before it can be granted the role" |

A migração e o backfill rodaram no stack local:
- `0002_party_documents` aplicada sobre 60 parties existentes;
- backfill dos índices de busca: 2 e 58 linhas nos dois tenants. Uma segunda execução
  preencheu 0.

A primeira tentativa da migração falhou (`23502` em `document_type`). O `UPDATE` de
backfill roda com o dono da tabela, que também está sujeito ao RLS forçado, e não viu
nenhuma linha. A transação foi desfeita inteira. A migração agora usa o mesmo padrão da
`0002_payables` do Financeiro: `NO FORCE ROW LEVEL SECURITY` só durante o `UPDATE`.

## Verificação

- **Parties:**
  - 29 testes unitários, 17 deles novos:
    - 10 nos casos de uso, com repositório em memória;
    - 7 no domínio (documento, contatos por papel, identificação, perfil fiscal,
      normalização);
  - cobertura de domínio e aplicação em 89% (antes 31%);
  - e2e com PostgreSQL: 13 passando, 4 novos:
    - documento estrangeiro cifrado e único por país;
    - vários `none` lado a lado e identificação depois;
    - checagem de duplicata com RLS e limpeza na eliminação;
    - backfill idempotente.
- **Contratos:** 3 testes novos (país coerente com o tipo, só o nome é obrigatório);
  compatibilidade sem quebra.
- **Sales:** 120 testes unitários, 5 novos:
  - prospect ignorado;
  - ex-cliente mantém contatos;
  - cliente sem contato recusado;
  - v1 igual a v2;
  - atualização v2 de prospect.

  e2e: 25 passando.
- **Compras:** 42 testes unitários; e2e com 18, 1 novo (v1 e v2 e ex-fornecedor).
- **Financeiro:** e2e com 35, 1 novo (título para cliente estrangeiro e prospect recusado).
- **Web:** 61 testes unitários, 3 novos (`documentOf`, `requiresContact`,
  `maskedDocument`).
- **`make check`:** passou (fronteiras, lint, typecheck e testes de todos os projetos).
- **CI local (`make ci-local`):** todas as etapas passaram:
  - repositório, pins, compatibilidade de contratos e arquivos gerados;
  - build e testes de todos os projetos;
  - e2e de todos os serviços.
- **Jobs isolados reproduzidos:** checkout só do módulo e contratos vindos de um registro
  descartável na porta 4874. Parties, Sales, Compras, Financeiro e web passaram em
  `npm ci`, typecheck, lint, testes (29, 120, 42, 37 e 61) e build.
- **Stack local:**
  - `make demo` passou;
  - `npm run test:browser` (golden path, com o aviso de duplicata), `test:browser:services`
    e `test:browser:fiscal` passaram depois das mudanças de CSS;
  - navegador em pt-BR: cadastro de estrangeiro escolhendo a opção do select com o mouse,
    aviso de duplicata, informar documento e diálogo em 390 px de largura.

## Achado fora do escopo

O consumidor do `webhooks` rejeita eventos que chegam à sua fila e os manda para a
dead-letter:
- são 797 mensagens desde 19/09, de vários módulos e versões, inclusive `sales.quote.sent`
  v1;
- não é regressão desta fase;
- como toda DLQ recebe todo dead letter (`#`), elas aparecem em todas as filas `.dlq`.

Fica para investigação própria.
