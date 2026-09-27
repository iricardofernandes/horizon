# Fase 60 — evidências: telas do CRM, golden path e fechamento da fase L

Status: **concluída em 2026-09-27; fase L fechada** (execuções locais entre 17:30 e 18:20 UTC).
Plano: [crm-phase60-implementation-plan.md](crm-phase60-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **Navegação:** grupo **CRM** no menu, visível para quem tem qualquer papel no módulo
  `crm` (ADR 0045) e escondido no perfil de demonstração hospedado. Cinco telas em
  `/app/crm/`, em pt-BR e em inglês.
- **Funil de vendas:**
  - um quadro por funil, com uma coluna por etapa. Uma etapa arquivada só aparece enquanto
    ainda tiver oportunidade aberta;
  - o card move arrastando, ou com as setas ← → do teclado, e uma região `aria-live`
    anuncia a mudança;
  - visão em tabela com filtro de situação (abertas, ganhas, perdidas);
  - "Nova oportunidade".
- **Oportunidade (diálogo):**
  - fatos, orçamentos vinculados, conversão e linha do tempo;
  - ações conforme o papel: mover, transferir, perder com motivo, ganhar e reabrir. Uma
    oportunidade convertida explica por que não reabre;
  - abas para registrar atividade, tarefa e nota;
  - **converter em orçamento**, em três passos visíveis:
    1. cliente no cadastro (concede `customer` se ainda for prospect);
    2. cliente no Sales (espera até 30 s, com "Tentar de novo");
    3. orçamento criado, com a mesma chave de idempotência nas novas tentativas e link
       para o orçamento.
- **Contas:**
  - lista com busca e papel;
  - "Novo prospect" pelo formulário compartilhado do Parties, com o aviso de duplicata;
  - diálogo com perfil (responsável, origem, segmento, etiquetas), contatos, oportunidades,
    registros e linha do tempo.
- **Minha agenda:** tarefas abertas do usuário por horizonte (24 h, 7 dias, 30 dias), com as
  atrasadas marcadas, concluir e cancelar.
- **Previsão e métricas:**
  - o corte vazio é "agora" no relógio do servidor, e a tela diz se o corte está fechado;
  - previsão por funil, responsável ou origem;
  - métricas do funil escolhido: etapas, conversões, taxa de ganho e motivos de perda.
- **Configurações:**
  - funis e etapas: criar, renomear, reponderar, subir, descer, arquivar e restaurar;
  - origens e motivos de perda. Só leitura sem `configure`.
- **Sales:** a tela de orçamentos abre um orçamento por `?open=`, o link da conversão.
- **Evidência de release:**
  - `scripts/crm-golden-path.mjs`;
  - `web/scripts/crm-workflow.e2e.mjs` (`npm run test:browser:crm`);
  - `scripts/phase60-restore-check.sh`;
  - [modelo de ameaças](crm-threat-model.md) e [referência da API](crm-api.md);
  - glossário (atribuição, conversão, previsão, corte);
  - catálogo de eventos (gerado, contratos 0.45.0).

## Critérios de saída da fase 60

| Critério | Evidência |
|---|---|
| `make check` e o CI local passam | ver Verificação |
| O golden path e o fluxo de navegador passam em pt-BR e em inglês | golden path pela API duas vezes seguidas; fluxo de navegador no build de produção (container `web`), inteiro em pt-BR e depois as cinco telas e o diálogo em inglês |
| Os dois critérios de saída da fase L estão provados | abaixo |

## Critérios de saída da fase L (plano de expansão)

| Critério | Evidência |
|---|---|
| Conta/contato/oportunidade → orçamento aceito preserva a atribuição da origem e o responsável | golden path: prospect estrangeiro (DE) → contato → oportunidade com origem → 3 etapas → cliente → orçamento v1 → troca de responsável → v2 renegociada → aceita. A v1, a v2 e os três `sales.quote.*` levam o responsável e a origem da oportunidade no momento da oferta; `crm.opportunity.converted` leva a origem e o total aceito. Fluxo de navegador: o orçamento aceito pela tela guarda a origem e o responsável da oportunidade. Fase 58: e2e do Sales e do CRM |
| As métricas do funil podem ser reconstruídas a partir do histórico | golden path: números num corte fixo (previsão por origem e métricas do funil) antes e depois de `rebuild:metrics` no container, com 0 divergência e números iguais. Fase 59: e2e apagando as projeções e reconstruindo aos mesmos números |

## Golden path (`node scripts/crm-golden-path.mjs`)

| Passo | Resultado |
|---|---|
| Prospect estrangeiro e prospect sem documento | projetados no CRM como `foreign`/`DE` e `none` |
| Contato em cada um; funil de 3 etapas; origem; motivo de perda | criados |
| Oportunidade do estrangeiro por Qualificação → Proposta → Negociação | fatos `created, stage-changed, stage-changed` |
| Oportunidade do sem documento, perdida | motivo "Prazo" |
| Tarefa com lembrete já vencido | `remindedAt` preenchido; um único `crm.task.due` no barramento |
| Conversão: `customer` concedido, Sales lista o cliente, orçamento v1 enviado, responsável trocado, v2 enviada e aceita | as duas versões com a atribuição original; oportunidade `won` com `conversion` (raiz = v1, versão 2) e valor = total da v2; fatos `…, owner-changed, won, converted` |
| Métricas no corte | 1 ganha, 1 perdida (5000 bps), motivo "Prazo" 1; previsão por origem com o valor ganho |
| `rebuild:metrics` | 16 oportunidades na primeira execução e 18 na segunda, 0 divergências, números inalterados |

As duas execuções seguidas passaram (a segunda, `muk4h0pn`, com os mesmos fatos e a
reconstrução sem divergência).

## Fluxo de navegador (`npm run test:browser:crm`)

Contra o build de produção (container `web`), logado como o operador fiscal, que recebeu
`crm:admin` pelo Identity:

| Passo (pt-BR) | Resultado |
|---|---|
| Configurações | funil com Qualificação e Proposta (60%); origem e motivo de perda |
| Contas | prospect sem documento registrado pelo CRM (confirmando o aviso de duplicata quando aparece); contato; ligação registrada com o contato |
| Funil | oportunidade aberta; arrastada para Proposta; ← de volta para Qualificação (anúncio "movida para Qualificação"); → para Proposta |
| Oportunidade | tarefa com lembrete e nota; as duas na linha do tempo |
| Minha agenda | a tarefa listada |
| Conversão | os três passos concluídos; "Abrir o orçamento" abre o diálogo no Sales; enviado e aceito; a oportunidade mostra "Ganha pelo orçamento aceito QT-…" e a timeline "Convertida por orçamento aceito"; a API confirma a atribuição do orçamento |
| Previsão e métricas | taxa de ganho; conversões Qualificação → Proposta 2 e Proposta → Qualificação 1 |
| Inglês | Pipeline, Accounts, My agenda, Forecast and metrics e CRM settings; o diálogo em inglês com "Won by the accepted quote QT-…" |

Nenhum erro de página no navegador. Os fluxos de navegador existentes continuam passando
com o menu novo: o golden path de bens (`make test-phase10`), o de serviços (fase 53) e o
fiscal (fase 48).

## Checagem de restauração (`scripts/phase60-restore-check.sh`)

- **Dados:** `horizon_crm` foi exportado e restaurado num PostgreSQL novo, com os papéis do
  módulo. As 19 tabelas do CRM batem com o banco vivo para o tenant (contas, contatos e
  chaves, funis, oportunidades e histórico, orçamentos vinculados, chaves de conta,
  atividades, tarefas, notas e revisões, as três projeções de métricas, auditoria).
- **Proteções no banco restaurado:**
  - reescrever o histórico e uma revisão de nota é recusado;
  - um fato retroativo é recusado;
  - uma chave de contato apagada não volta;
  - o papel relay não lê o título de uma tarefa;
  - outro tenant não vê nenhuma oportunidade.
- **Triggers:** o `pg_restore` carrega os dados antes de criar os triggers, então o
  histórico antigo é restaurado sem esbarrar na tolerância de instante.

## Descobertas no caminho

- **O container `fiscal` do stack local estava parado nos contratos 0.40.0.**
  - Ele fica no profile `fiscal` do compose, que o `make up-apps` não reconstrói.
  - Os contratos 0.40.0 não conhecem o módulo `crm`, e o Fiscal valida os papéis do token
    com eles. Quando o operador fiscal recebeu `crm:admin`, todo token dele passou a ser
    recusado pelo Fiscal, e o fluxo de serviços caiu na tela de login.
  - `make up-fiscal` reconstruiu o Fiscal com 0.45.0, e os fluxos de serviços e fiscal
    voltaram a passar.
  - No CI o Fiscal é construído com os contratos fixados; é a regra de rollout de um módulo
    novo (erp-expansion-plan) valendo também para o stack local.
- **Corte arredondado ao minuto** e **selects com padrão alterado depois de montados:**
  corrigidos (ver o plano, "Revisions made while implementing").
- **Webhooks:** a rejeição dos eventos de tenants não provisionados (fase 57) continua
  aberta e está no modelo de ameaças como item aberto.

## Verificação

- **Web:**
  - 69 testes unitários (8 novos: movimentos do quadro, colunas, rótulos, conversão,
    durações, instantes e o grupo CRM na navegação);
  - `lint` com a checagem de textos da interface (nenhum texto inline);
  - `typecheck`; `next build`.
- **CRM, Sales e contratos:** sem mudança de código nesta fase além do link `?open=` do
  Sales; as suítes das fases 54–59 continuam passando no CI local.
- **`make check`:** passou.
- **CI local (`make ci-local`):** passou em todas as etapas, rodado depois de este arquivo
  existir ("Local code and integration gates passed"): repositório, pins, compatibilidade
  de contratos, arquivos gerados, build e testes de todos os projetos, e2e de todos os
  serviços.
