# Fase 50 — evidências da ordem de serviço e da execução

Status: **concluída em 2026-09-26** (execuções locais entre 01:18 e 01:40 UTC de 27/09).
Plano: [services-phase50-implementation-plan.md](services-phase50-implementation-plan.md).
Decisão: [ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md).

## O que foi entregue

- **Contratos `@horizon/contracts` 0.38.0** (aditivos):
  - eventos `sales.service.delivered` e `sales.service.delivery-cancelled`;
  - origem `sales-service-delivery` no título do Financeiro;
  - esquemas HTTP da política de emissão e da entrada de serviço no Fiscal.

  Todos os módulos foram fixados na 0.38.0, e o catálogo `docs/events.md` foi gerado de
  novo.
- **Sales:**
  - migração `0012_service_orders`: ordens de serviço, linhas, entregas e linhas de
    entrega, com RLS, uma ordem por proposta e um gatilho que impede reescrever uma entrega
    registrada;
  - agregado `ServiceOrder`: `scheduled` → `in_progress` → `completed` → `accepted`, ou
    `cancelled` com motivo. As entregas são parciais por linha;
  - cobrança da entrega (`service-billing.ts`):
    - cada entrega leva sua parte do total, com o desconto proporcional;
    - a entrega que completa a ordem cobra o que falta, então a soma bate exatamente com
      o total;
  - conversão da proposta:
    - as mercadorias viram pedido de venda (e só elas pedem depósito);
    - os serviços viram ordem de serviço, na mesma transação e com a mesma chave;
    - o desconto é dividido pelo líquido de cada lado, e o frete fica com as mercadorias;
  - rotas `/sales/service-orders` (abrir, iniciar, entregar, aceitar, cancelar, cancelar
    entrega);
  - cancelar uma entrega mantém o registro, publica o cancelamento e deixa o trabalho em
    aberto de novo.
- **Financeiro:**
  - um título efetivo por entrega (`SV-…`), com as parcelas da entrega;
  - no cancelamento da entrega:
    - o rascunho é cancelado;
    - o título lançado sem baixa é estornado;
    - com baixa, fica para uma pessoa, com registro na auditoria.
- **Fiscal:**
  - migração `0051_phase50_service_intake`: política de emissão por estabelecimento e
    entradas de serviço (uma por linha entregue), com RLS e um gatilho que só deixa a
    entrada avançar;
  - a entrada gera origem com chave `sales` / `service-delivery` / `entryId` / mês de
    competência e rascunho; na política `automatic`, também valida e emite;
  - o que impede o caminho fica bloqueado com o motivo e é tentado de novo com espera
    crescente. Exemplos: perfil de serviço ausente, município sem suporte, dia de
    competência que ainda não começou no fuso do emissor;
  - no cancelamento da entrega:
    - a NFS-e autorizada recebe o evento 101101, motivo 2;
    - fora do prazo municipal, a entrada fica `cancellation-refused`;
    - o rascunho é retirado e não pode mais ser emitido;
  - API:
    - `GET`/`PUT /fiscal/service-issuance-policies/{estabelecimento}`;
    - `GET /fiscal/service-intakes`;
    - `POST /fiscal/service-intakes/{id}/retry`.
- **Web:** a proposta aceita converte serviços. Pede depósito só quando há mercadorias,
  explica que os serviços viram ordem de serviço e mostra os documentos gerados. As telas
  da ordem de serviço ficam para a fase 53.

## Defeito encontrado e corrigido

- **Repetição idempotente pelo gateway.**
  - O Sales calculava a impressão digital do comando junto com o contexto, incluindo o
    `x-request-id`. O Kong gera um id novo a cada requisição, então repetir um comando com
    a mesma `Idempotency-Key` era recusado como "pedido diferente".
  - O smoke achou isso ao repetir a conversão. Agora a impressão digital cobre só o comando
    e o corpo, e há teste unitário.
  - O mesmo padrão existe no Inventory, que não foi alterado nesta fase.

- **Corrida no worker do Fiscal**, achada na revisão do código:
  - um cancelamento que chegasse enquanto um passo de avanço rodava podia ter o próximo
    horário sobrescrito pelo registro do passo, e a retirada ficaria parada;
  - agora a retirada pedida durante o passo fica devida na hora;
  - um e2e dispara o cancelamento de dentro da criação do rascunho.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Repetir `sales.service.delivered` não cria segundo título, origem ou NFS-e | e2e do Financeiro (mesmo evento e mesmos fatos com outro id); e2e do Fiscal (idem, e fatos diferentes na mesma linha recusados); smoke: republicação com novo `eventId` consumida pelos dois módulos, com 1 título e 1 entrada |
| O cancelamento desfaz os dois | e2e do Financeiro (rascunho cancelado, lançado estornado, com baixa sinalizado); e2e do Fiscal (101101 e rascunho retirado com emissão recusada); smoke: título `cancelled` e NFS-e `cancelled` |
| RLS e isolamento entre tenants nas tabelas novas | e2e do Sales (quatro tabelas, leitura e escrita cruzadas); e2e do Fiscal (entradas invisíveis para outro tenant) |
| Uma proposta vira os dois documentos uma vez | unitários e e2e do Sales; smoke com repetição da conversão pela mesma chave |
| As entregas somam o total | testes de domínio com entregas parciais, desconto e cancelamento |

## Verificação

- **Contratos:** 105 testes, sendo 3 novos; gate de compatibilidade: 7 adições, nenhuma
  quebra.
- **Sales:**
  - 87 testes unitários, sendo 12 novos (domínio, casos de uso e repetição pelo gateway);
  - e2e com PostgreSQL: 20 passando. São 2 novos (ciclo com entregas, eventos e gatilho;
    isolamento) e 1 reescrito (a proposta mista agora converte).
- **Financeiro:** 37 testes unitários e 32 e2e, sendo 3 novos (repetição, cancelamento
  nos três estados, cancelamento antes da entrega).
- **Fiscal:**
  - 171 testes unitários (1 novo, de API);
  - 56 e2e, sendo 4 novos: emissão automática com repetição e cancelamento; bloqueio,
    nova tentativa e retirada; cancelamento que chega durante o passo de rascunho;
    cancelamento antes da entrega.
- **Web:** 50 testes unitários, lint, typecheck e build.
- **Jobs isolados reproduzidos** (checkout só do módulo, contratos 0.38.0 vindos do registro
  local): Sales, Financeiro, Fiscal e web com typecheck, lint, testes e build. O Fiscal foi
  repetido depois da correção da corrida.
- **CI local (`make ci-local`):**
  - a primeira passagem falhou em dois pontos:
    - fronteiras: um teste de domínio chamava `toSnapshot()` direto (ADR 0031) e passou a
      usar `snapshotOf`;
    - links: o arquivo de evidências ainda não existia;
  - a segunda passagem foi limpa;
  - as verificações do Fiscal foram repetidas depois da última correção: typecheck,
    lint, 171 unitários, 56 e2e e build.

### Smoke no stack local

`scripts/phase50-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`, cinco
execuções. A quarta rodou depois da correção da corrida no worker do Fiscal, e a quinta
depois da refatoração que reduziu a complexidade da conversão e do diálogo. Cada uma:
1. Cria um serviço com preço e perfil fiscal, e um cliente com perfil fiscal nacional.
2. Põe a política do estabelecimento em `automatic`, série 50. No fim, volta para
   `review`, série 1.
3. Cria uma proposta com uma mercadoria e o serviço (quantidade 2, desconto R$ 10,00),
   envia, aceita e converte.
   - A repetição com a mesma chave devolve os mesmos documentos.
   - O `sales.order.placed` leva só a mercadoria.
4. Inicia a ordem de serviço, entrega 1, entrega o resto e aceita. As duas entregas
   (R$ 1.195,03 cada) somam o total da ordem (R$ 2.390,06).
5. Cria um título em rascunho por entrega e uma NFS-e autorizada por entrega, série 50.
6. Republica o fato da primeira entrega com novo `eventId`. Financeiro e Fiscal consomem,
   e não surge título, entrada nem origem novos.
7. Cancela a primeira entrega:
   - título `cancelled`;
   - entrada `withdrawn`;
   - NFS-e `cancelled` por 101101;
   - ordem de volta a `in_progress`, com o faturado igual à segunda entrega.

| Execução (UTC) | Ordem de serviço | Pedido de venda | NFS-e | Republicação |
|---|---|---|---|---|
| 01:18 | `01a0e071-50a8-7a9b-84f6-12c7d9f1f1d2` | `01a0e071-50a8-7a9b-84f6-12c6890463df` | 5 e 6 | `d6d67718-5c53-41fd-bf25-3e0958ec6acc` |
| 01:20 | `01a0e072-fa11-72c2-b821-f12b4c41583d` | `01a0e072-fa10-7d10-b415-d9e0c5d31291` | 7 e 8 | `81cf29dc-1db7-4958-a18c-1ee27053771a` |
| 01:22 | `01a0e074-8910-74bb-ad83-fc641415591d` | `01a0e074-8910-74bb-ad83-fc631cdb2d9e` | 9 e 10 | `01e8ab13-da21-4b5a-93d1-f4d58a8cd0f4` |
| 01:30 | `01a0e07c-4a53-72b4-b93a-c01385a07b8b` | `01a0e07c-4a53-72b4-b93a-c0126eb506da` | 11 e 12 | `14594678-fdd1-497c-bf9b-585ff08cd5c8` |
| 01:35 | `01a0e080-f646-74b1-b97f-0313cfc08122` | `01a0e080-f646-74b1-b97f-0312acb8025e` | 13 e 14 | `7060811c-ae79-4efa-8e59-05a4d9a7af92` |

Duas execuções anteriores pararam, antes de corrigidos, nos defeitos descritos acima e nos
ajustes de fuso (plano, "Changes made during implementation"). As entregas delas ficaram
com entradas bloqueadas por E0015 e viram rascunho, na política `review`, quando o dia
começar em São Paulo.

### Navegador

`web/scripts/fiscal-workflow.e2e.mjs`, com um passo novo. Uma proposta só de serviço,
aceita por API, é aberta na tela:
- aparece o aviso de que os serviços viram ordem de serviço;
- não aparece o campo de depósito;
- "Gerar ordem de serviço" converte, e a tela mostra "viraram a ordem de serviço OS-…".

O golden path de navegador original (`npm run test:browser`) também passou. As duas
execuções de navegador foram repetidas depois da refatoração, às 01:37 UTC.

## Pendências e limites

- As telas da ordem de serviço (quadro, detalhe, entregas) e do cliente são da fase 53.
  Até lá, a API e o smoke são a superfície de operação.
- Não há receita prevista (forecast) para ordem de serviço aberta; o título nasce na
  entrega.
- Correção de uma entrega é cancelamento mais nova entrega; a substituição 105102 pelo
  Sales não entra nesta fase.
- Um cancelamento que chega antes da entrega é recusado e volta pela fila (uma nova
  tentativa do broker). Se chegar à fila de mensagens mortas, precisa ser republicado.
- Uma entrada bloqueada não gera métrica nem alerta ainda (fase 52).
- A idempotência do Inventory tem o mesmo defeito da impressão digital corrigido no Sales.
