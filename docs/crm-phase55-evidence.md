# Fase 55 — evidências: o módulo CRM, contas e contatos

Status: **concluída em 2026-09-27** (execuções locais entre 14:20 e 15:10 UTC).
Plano: [crm-phase55-implementation-plan.md](crm-phase55-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **Contratos 0.42.0:**
  - módulo `crm` com os papéis `admin`, `manager`, `representative` e `viewer`;
  - `kind` opcional (aditivo) em `parties.party.updated` v2;
  - todos os módulos fixados em 0.42.0 antes de qualquer papel `crm` ser concedido;
  - o teste de contrato do Identity reconhece o módulo.
- **Serviço `crm/`** (porta 3012, `/crm` no Kong, banco `horizon_crm`):
  - **contas:** projeção de toda Party com `prospect`, `customer` ou `partner`, com id
    igual ao da Party.
    - Nome, documento e papéis vêm do Parties; responsável (owner), segmento e tags são
      do CRM.
    - Sem papel de CRM a conta fica `inactive`. Com a Party eliminada, fica `erased` com
      os nomes apagados.
  - **contatos:** nome, cargo, e-mail, telefone e base legal (`contract`,
    `legitimate-interest` ou `consent`).
    - Os campos pessoais são cifrados com uma chave por contato. Eliminar o contato, ou
      a Party da conta, destrói a chave.
    - A criação é idempotente (`Idempotency-Key`).
  - **owners:** usuários só como id e ativo/inativo, via `identity.user.registered` e
    `identity.user.disabled`, mais `npm run backfill:owners` pela API do Identity. Um
    usuário desativado mantém suas contas, mas não recebe novas;
  - **auditoria** em cadeia de hash por tenant. Guarda só nomes de campo, nunca valores
    de contato;
  - **API:** contas (lista com busca, papel, owner e status; detalhe com contatos;
    perfil), contatos (criar, ler, revisar, ativar/desativar, eliminar) e owners;
  - **papéis:**
    - `viewer` lê;
    - `representative` escreve;
    - `manager` também troca o owner;
    - só `admin` elimina contato.
  - outbox e relay ligados; nenhum evento publicado ainda (fase 56).
- **Parties:** `npm run republish:parties -- --tenant <uuid>` republica
  `parties.party.updated` (com `kind`) de toda Party viva. É assim que as parties
  anteriores ao CRM viram contas, e os demais consumidores tratam o evento como
  atualização.
- **Ligação na plataforma:**
  - `modules.json`, Makefile (`SERVICES`) e compose (`crm-migrate`, `crm`);
  - Kong, script de init do Postgres e allowlist do proxy web;
  - workflows `golden-path`, `isolation` e `release`, e `ci-local`;
  - demo: migra `horizon_crm` e dá `crm:admin` ao operador;
  - README.
  - No cluster local, `horizon_crm` foi criado à mão com os mesmos comandos do init.
- **Postgres local com `max_connections=200`.** Com o 12º serviço, a primeira
  republicação esgotou as 100 conexões padrão ("remaining connection slots are reserved").
  Na hora, o Fiscal segurava 33 e o CRM 10.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Testes de RLS e entre tenants em todas as tabelas | e2e: um tenant intruso vê 0 linhas em `accounts`, `contacts`, `contact_data_keys`, `owners`, `audit_log`, `command_receipts` e `inbox`; a aplicação não tem `SELECT` no `outbox`; unitário com tenant intruso recebe "not found" |
| Eliminar a Party destrói os contatos da conta; eliminar um contato preserva a conta | e2e e smoke: `parties.party.erased` zera a chave de cada contato e apaga os nomes da conta; `DELETE /crm/contacts/{id}` zera só a chave daquele contato, e a conta segue `active` |
| O smoke cadastra um prospect no Parties e o encontra como conta no CRM | smoke: `POST /parties/parties` com prospect sem documento, depois `GET /crm/accounts/{id}` com `status: active`, `documentType: none`, `roles: ['prospect']` |

## Smoke no stack local

`node scripts/phase55-smoke.mjs` (tenant de demonstração), depois de `make up-apps`:

| Verificação | Resultado |
|---|---|
| Republicação das parties | 70 republicadas; as 57 com papel de CRM têm conta |
| Backfill de owners | 2 ativos e 1 desativado lidos do Identity |
| Usuário criado no Identity | aparece como owner ativo pelo evento |
| Prospect novo no Parties | conta `active` no CRM |
| Owner, segmento e tags | `changed: ownerId, segment, tags`; `representative` trocando owner: `403`; `representative` mudando tags: ok; `viewer` escrevendo: `403` |
| Owner desativado no Identity | refletido pelo evento; atribuir de novo: `400` "is a disabled user"; a conta mantém o owner |
| Contato | mesmo `Idempotency-Key` devolve o mesmo id; sem chave: `400`; campos cifrados no banco; lido de volta; desativado pelo `representative`; `DELETE` pelo `representative`: `403`; eliminado pelo `admin` (chave nula, conta ativa) |
| Party eliminada | conta `erased` sem nomes; a chave do segundo contato foi zerada |

O smoke rodou três vezes. Na segunda execução, a checagem "o total de contas aumentou"
não servia mais, porque as contas já existiam. Ela foi trocada por "toda Party viva com
papel de CRM tem conta".

## Verificação

- **CRM:**
  - 33 testes unitários: entidades, valores, mapa de papéis, casos de uso e consumidor de
    eventos (v1, v2, republicação, eliminação, owners);
  - cobertura de domínio e aplicação em 97% de linhas;
  - e2e com PostgreSQL: 8 testes:
    - contato só em texto cifrado e lido pela própria chave;
    - eliminação com chave que não volta (trigger);
    - eliminação da Party;
    - idempotência concorrente;
    - evento repetido aplicado uma vez;
    - cadeia de auditoria com hash conferido e `UPDATE` recusado;
    - RLS em todas as tabelas;
    - filtros da lista, inclusive `%` literal na busca.
- **Parties:** 30 unitários (republicação em páginas) e 14 e2e (republicação só do
  tenant, com `kind`).
- **Contratos:** teste dos papéis do CRM. A compatibilidade contra o snapshot 0.41.0
  acusou uma mudança aditiva (`kind` opcional), aceita.
- **`make check`:** passou.
- **e2e:** Identity com 47 testes passando.
- **Jobs isolados reproduzidos** (registro descartável na porta 4874): CRM, Identity e
  Parties passaram em `npm ci`, typecheck, lint, testes e build.
- **`make demo`:** passou (migra `horizon_crm`).

## Achados

- **Dead letters no Sales e no Compras.** Na primeira republicação, feita logo depois de
  reiniciar o Postgres e a stack:
  - 8 `parties.party.updated` foram para a DLQ no Sales e 1 no Compras;
  - as duas republicações seguintes, uma delas também logo após reiniciar, não geraram
    nenhuma;
  - a causa não pôde ser identificada, porque o consumidor desses módulos descarta o erro
    sem registrar nada;
  - como era republicação dos mesmos dados, nenhuma projeção ficou desatualizada;
  - o consumidor do CRM agora registra o tipo de evento e a classe do erro.
- **Webhooks.** O consumidor do `webhooks` continua rejeitando os eventos que recebe
  (achado da fase 54). Cada republicação adiciona cerca de 70 mensagens às DLQs.
- **Demo e stack em paralelo.** Um `sales.invoicing.requested` emitido pelo `make demo` foi
  para a DLQ do `financial.events`, porque o serviço rodando também o consome. O padrão
  já existia (46 casos antigos) e não tem relação com esta fase.
