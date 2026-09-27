# Fase 51 — evidências dos contratos recorrentes

Status: **concluída em 2026-09-26** (execuções locais às 01:55 UTC de 27/09).
Plano: [services-phase51-implementation-plan.md](services-phase51-implementation-plan.md).
Decisão: [ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md).

## O que foi entregue

- **Contratos `@horizon/contracts` 0.39.0** (aditivos):
  - eventos `sales.contract.activated`, `sales.contract.amended`,
    `sales.contract.suspended` e `sales.contract.cancelled`;
  - todos os módulos fixados na 0.39.0, e o catálogo de eventos gerado de novo.
- **Sales:**
  - migração `0013_service_contracts`:
    - contratos, revisões e linhas de revisão, que só aceitam inclusão;
    - suspensões, que só ganham a data de retomada, uma vez;
    - RLS nas quatro tabelas;
    - gatilhos que impedem mudar o cancelamento, o cliente, a moeda, o início e o dia de
      cobrança;
  - grade de períodos (`contract-schedule.ts`):
    - os períodos são mês, trimestre ou ano a partir do dia 1, com o nome do primeiro mês
      (a competência) e o dia de cobrança;
    - a revisão em vigor é a última que começa até o início do período;
    - uma mudança de recorrência reancora a grade;
  - agregado `ServiceContract`: rascunho, ativação, aditivo, suspensão, retomada,
    cancelamento e renovação (manual com reajuste em pontos-base, ou automática sem
    reajuste depois que o último período começa). O status é lido num dia;
  - regra central: toda mudança vale a partir de um período que ainda não começou, então
    um período iniciado mantém a revisão e o valor;
  - rotas `/sales/contracts`: criar, ler, cronograma, ativar, aditar, suspender, retomar,
    cancelar, renovar, e `POST /sales/contracts/renewals` para as renovações automáticas.

Nenhum outro módulo consome os eventos ainda. A cobrança dos períodos é a fase 52.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Um aditivo depois de um período mantém a revisão e o valor daquele período | teste de domínio compara o cronograma antes e depois; smoke: os dois primeiros meses iguais depois do aditivo, e os 18 primeiros iguais depois do cancelamento |
| A suspensão remove exatamente os períodos que cobre | teste de domínio; e2e (2 períodos suspensos); smoke: só 2 meses fora, o resto idêntico |
| A renovação continua o cronograma sem lacuna nem sobreposição | testes de domínio e de caso de uso; e2e da renovação automática (6 períodos contíguos) e da manual (24); smoke: 24 períodos contíguos e o reajuste de 4,5% aplicado |

## Verificação

- **Contratos:** 106 testes (1 novo, com os quatro eventos); gate de compatibilidade só
  com adições.
- **Sales:**
  - 100 testes unitários, sendo 13 novos: 10 de domínio (grade, aditivo, recorrência,
    suspensão, cancelamento, renovação, arredondamento) e 3 de caso de uso;
  - e2e com PostgreSQL: 22 passando, sendo 2 novos:
    - ciclo completo com eventos no outbox, revisões que não aceitam alteração, suspensão
      que só ganha a retomada, e isolamento entre tenants nas quatro tabelas;
    - renovação automática idempotente e sem lacuna.
- **Jobs isolados reproduzidos** (checkout só do módulo, contratos 0.39.0 vindos do registro
  local): Sales e contratos com typecheck, lint, testes e build.
- **CI local (`make ci-local`):**
  - a primeira passagem falhou em dois pontos:
    - links: o arquivo de evidências foi escrito durante a execução;
    - espaços: uma linha em branco sobrando no fim do ADR 0056;
  - a segunda passagem foi limpa.

### Smoke no stack local

`scripts/phase51-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`, três
execuções. Cada uma:
1. Cria um serviço a R$ 900,00 e um contrato mensal:
   - de 01/10/2026 a 30/09/2027;
   - cobrança no dia 10, pagamento em 15 dias.
2. Ativa. O cronograma tem 12 períodos na revisão 1, cobrados no dia 10 de cada mês.
3. Tenta aditar a partir do mês corrente e recebe `409`. Adita a partir de dezembro:
   2 postos a R$ 850,00 negociados. Outubro e novembro ficam idênticos.
4. Suspende de fevereiro de 2027 e retoma em abril: só fevereiro e março ficam fora, e o
   resto do cronograma não muda.
5. Renova com reajuste de 450 pontos-base (4,5%):
   - o fim vai para 30/09/2028;
   - 24 períodos contíguos;
   - os 12 primeiros ficam idênticos;
   - o novo valor é R$ 1.776,50.
6. Cancela a partir de abril de 2028: os 18 primeiros ficam idênticos e os seguintes
   ficam como `cancelled`.
7. O outbox tem, nesta ordem: ativação, aditivo, suspensão, retomada, renovação e
   cancelamento.

| Execução (UTC) | Contrato |
|---|---|
| 01:55:46 | `01a0e093-5692-7ac8-a023-f91309814601` |
| 01:55:53 | `01a0e093-734f-7df6-b886-b3ab7ee4a226` |
| 01:55:54 | `01a0e093-7820-740c-ac7c-6dc8b2107bf0` |

## Pendências e limites

- Faturar períodos, rodadas em lote e créditos é a fase 52. Ela acrescenta a checagem de
  "não faturado" à regra de mudanças e chama as renovações automáticas antes de cobrar.
- As telas de contratos são da fase 53.
- Sem rateio de período parcial nem índice externo de reajuste: o contrato começa no dia
  1 e o reajuste é digitado por quem revisa.
- A renovação automática roda por chamada (`POST /sales/contracts/renewals`), ainda sem
  agendador.
