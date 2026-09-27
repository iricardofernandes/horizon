# Fase 57 — evidências: atividades, tarefas, notas e lembretes

Status: **concluída em 2026-09-27** (execuções locais entre 16:30 e 17:00 UTC).
Plano: [crm-phase57-implementation-plan.md](crm-phase57-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **Contratos 0.44.0:** `crm.task.due` (v1). O evento traz a tarefa, a conta, o vínculo, o
  responsável e os instantes de vencimento e de lembrete. O schema recusa o campo `title`.
  Todos os módulos foram fixados em 0.44.0.
- **Vínculo:**
  - atividades, tarefas e notas se prendem a uma conta, um contato ou uma oportunidade;
  - a conta sempre fica gravada, tirada do vínculo e nunca da requisição;
  - só entra registro em conta ativa, e o vínculo precisa estar vivo: contato não apagado,
    oportunidade da conta.
- **Texto sob a chave da conta:**
  - título e resumo de atividade, título de tarefa e revisões de nota são cifrados com uma
    chave da conta (`account_data_keys`), criada com o primeiro registro;
  - apagar a party destrói a chave e cancela as tarefas abertas da conta;
  - as leituras mostram o texto como `null`, e a chave destruída não pode voltar (trigger).
- **Atividades:** ligação, reunião, e-mail ou visita, com participantes que são contatos
  vivos da conta.
  - Um instante mais de cinco minutos no futuro é recusado.
  - A correção audita os nomes dos campos alterados, nunca o texto.
- **Tarefas:**
  - responsável ativo, vencimento e lembrete opcional (não posterior ao vencimento);
  - revisar, reatribuir, concluir, cancelar. Nada é apagado;
  - atribuir a outra pessoa exige `assign`.
- **Notas:** a correção acrescenta uma revisão, e `note_revisions` é append-only por
  trigger.
- **Lembretes:**
  - um worker no processo do CRM pergunta, como `horizon_relay`, só quais tenants têm
    lembrete vencido (quatro colunas de `tasks`, nenhum texto);
  - em cada tenant, reivindica as tarefas com `FOR UPDATE SKIP LOCKED` e grava
    `reminded_at` e o outbox na mesma transação;
  - reagendar arma o lembrete de novo.
- **Leituras:**
  - `GET /agenda`: as tarefas abertas do chamador até o horizonte, com as atrasadas
    marcadas;
  - `GET /tasks`, `/tasks/{id}`, `/activities/{id}` e `/notes/{id}`, esta com as revisões;
  - timelines de conta e de oportunidade, ordenadas no SQL (mais recente primeiro, com
    desempate estável) e paginadas.
- **Migração `0002_activities`:** as cinco tabelas novas, RLS forçado, grants por coluna e
  a política `reminder_scan` para `horizon_relay`.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Um lembrete dispara uma vez, mesmo com o agendador reiniciado ou rodando em dobro | e2e: dois agendadores com conexões próprias rodam quatro passadas ao mesmo tempo, depois um terceiro "reiniciado"; o outbox tem exatamente um `crm.task.due` por tarefa vencida, e nenhum para a que vence depois nem para a sem lembrete. Reagendar gera o terceiro. Unitário: execuções repetidas e novas instâncias não reenviam. Smoke: um `crm.task.due` na fila de prova, e ainda um só depois de `docker restart horizon-crm` e 35 s |
| A timeline é ordenada e restrita ao tenant | e2e: instantes em ordem decrescente; a conta reúne atividades (de conta, contato e oportunidade), nota e histórico da oportunidade; a da oportunidade só o que é dela; a página `limit 2 offset 2` bate com a lista inteira; outro tenant vê `total 0`, e nenhuma linha das tabelas novas. Smoke: as duas timelines pelo Kong |
| Corrigir uma nota mantém o texto anterior | unitário e e2e: duas revisões com os dois textos; o PostgreSQL recusa `UPDATE` e `DELETE` em `note_revisions`. Smoke: `GET /notes/{id}` com as duas revisões |

## Smoke no stack local

`node scripts/phase57-smoke.mjs` (tenant de demonstração), depois de `make up-apps`.
Uma fila de prova ligada a `crm.task.#` é criada e removida pelo script.

| Verificação | Resultado |
|---|---|
| Conta nova (prospect sem documento), contato, funil e oportunidade | criados |
| Representante registra ligação com o contato, repetida com a mesma chave | mesmo id |
| Atividade uma hora no futuro | `400` |
| Nota na oportunidade, corrigida | revisão 2, as duas versões lidas de volta |
| Representante dá tarefa a um colega | `403` |
| Representante dá tarefa a si mesmo, lembrete em 5 s | criada; aparece na agenda, não atrasada |
| Timeline da oportunidade | `opportunity-event, task, note, opportunity-event` |
| Timeline da conta | a mesma, mais a ligação no fim (a mais antiga) |
| RabbitMQ | um `crm.task.due` com responsável e vínculo, sem o título |
| `docker restart horizon-crm` e 35 s de espera | ainda um só |
| Concluir a tarefa | sai da agenda |

O primeiro smoke também conferia se a DLQ do `webhooks` não crescia, e ela cresceu 4
mensagens (`parties.party.registered` v2, `crm.opportunity.created`, `stage-changed` e
`crm.task.due`).
- **Causa:** o consumidor do `webhooks` grava o evento numa tabela com chave estrangeira
  para `tenants`, e nenhum código de produção provisiona um tenant ali. Só existe um
  tenant, criado à mão numa fase anterior. Todo evento do tenant de demonstração é
  rejeitado, qualquer que seja o tipo.
- **Escopo:** isso vem de antes do CRM e explica as rejeições antigas do `webhooks`
  registradas nas fases 54 a 56. Fica fora desta fase, e a verificação saiu do smoke.
  Com a versão 0.44.0, o contrato `crm.task.due` é conhecido pelo `webhooks`.
- **Outras filas:** nenhuma mensagem nas DLQs veio do consumidor `crm.events`.

## Verificação

- **CRM:**
  - 72 testes unitários (19 novos): tarefa, nota, valores, casos de uso de atividades,
    tarefas, notas, lembretes e apagamento da party;
  - cobertura de domínio e aplicação em 97,6% de linhas;
  - e2e com PostgreSQL: 19 testes, 6 novos em `test/records.e2e-spec.ts`:
    - texto só como cifra e apagado com a party;
    - revisões append-only;
    - lembrete único com agendadores concorrentes e reiniciados;
    - papel relay sem acesso a texto;
    - timeline ordenada, paginada e isolada;
    - agenda.
- **Contratos:** 1 teste novo (`crm.task.due` recusa título e vínculo desconhecido).
- **`make check`:** passou.
- **CI local (`make ci-local`):** passou em todas as etapas, rodado depois de este arquivo
  existir ("Local code and integration gates passed"): repositório, pins, compatibilidade
  de contratos, arquivos gerados, build e testes de todos os projetos, e2e de todos os
  serviços.
- **Jobs isolados:** `crm` (72 testes e build) e `webhooks` passaram com um registro
  descartável e os contratos 0.44.0 publicados a partir da árvore de trabalho.
