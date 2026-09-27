# Fase 53 — evidências das telas de serviço, do golden path e do fechamento da fase K

Status: **concluída em 2026-09-27** (execuções locais entre 03:00 e 03:45 UTC).
Plano: [services-phase53-implementation-plan.md](services-phase53-implementation-plan.md).
Decisão: [ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md).
Operação: [runbook](services-billing-runbook.md) · [referência da API](services-api.md) ·
[modelo de ameaças](services-threat-model.md).

## O que foi entregue

- **Sales:**
  - migração `0015_service_delivery_effects`: o título e a NFS-e de cada entrega, em
    tabelas próprias com RLS. Uma entrega cancelada nunca é reescrita, por isso os efeitos
    não são colunas dela;
  - os consumidores passam a acompanhar também as entregas:
    - o título lançado de origem `sales-service-delivery`;
    - o estorno;
    - a NFS-e com chave `service-delivery` (uma observação mais antiga não sobrescreve uma
      mais nova);
  - `GET /sales/service-orders/{id}` devolve os efeitos de cada entrega;
  - `authorization.spec.ts` cobre os papéis nas rotas de serviço.
- **Web (pt-BR e en):**
  - **Ordens de serviço:** quadro por etapa e diálogo de nova ordem. O detalhe traz:
    - vendido, entregue e o que falta;
    - as entregas, com título e NFS-e;
    - iniciar, registrar entrega, aceitar, cancelar a ordem e cancelar uma entrega.
  - **Contratos:** lista com a situação de hoje e diálogo de novo contrato (preço
    negociado, início, prazo, dia de cobrança, renovação). O detalhe tem quatro abas:
    - resumo e decisões: ativar, suspender, retomar, cancelar;
    - revisões: aditivo e renovação com reajuste;
    - cronograma: faturar um período devido;
    - faturados: título, NFS-e e crédito.
  - **Faturamento de contratos:**
    - mês, prévia e rodada. A tela mantém a mesma chave por mês até a resposta, então
      repetir o clique retoma a mesma rodada;
    - rodadas recentes;
    - períodos esperando título ou NFS-e.
  - **Clientes → Serviços:** as ordens de serviço e os contratos de um cliente.
  - **Links:**
    - "Ver no Financeiro" abre o título lançado (`?open=`) ou procura a referência de um
      rascunho (`?search=`);
    - "Ver documento" abre a NFS-e na tela do Fiscal (`?open=`);
    - um título retirado por cancelamento ou crédito aparece como "retirado".
- **Evidências:**
  - `scripts/phase53-golden-path.mjs`;
  - `web/scripts/services-workflow.e2e.mjs` (`npm run test:browser:services`);
  - `scripts/phase53-restore-check.sh`.
- **Documentação:**
  - runbook completo;
  - `services-threat-model.md` e `services-api.md`;
  - glossário;
  - fase K fechada nos planos e no ADR.

## Critérios de saída

| Critério | Evidência |
|---|---|
| `make check` e o CI local passam | ver Verificação |
| O golden path e o workflow de navegador passam em pt-BR e en | `phase53-golden-path.mjs` (03:38 UTC); `services-workflow.e2e.mjs` (03:35 UTC), em pt-BR e depois em inglês; golden path de mercadorias no navegador e workflow do Fiscal de novo verdes |
| Passam as suítes de duplicidade, queda e isolamento entre tenants | e2e do Sales (rodada interrompida e retomada, rodada nova, restrição única, RLS em todas as tabelas de serviço, incluindo as de efeitos); e2e do Financeiro e do Fiscal (repetição) |
| Nenhuma nota, pedido fiscal ou título duplicado (fase K) | Golden path: rodada repetida pela mesma chave (mesma rodada), rodada nova (`already-billed`), republicação do evento com novo id: 1 título, 1 entrada e 1 NFS-e por período e por entrega |
| Mudanças com data de vigência nunca reescrevem período faturado (fase K) | Golden path: aditivo num mês faturado recusado com `409`; aditivo do mês que vem aceito; os dois meses faturados continuam na revisão 1 com o mesmo valor, e o cronograma mostra a revisão 2 só a partir do mês que vem |

## Verificação

- **Sales:**
  - 115 testes unitários, sendo 3 novos (autorização das rotas de serviço);
  - e2e com PostgreSQL e RabbitMQ: 25 passando, sendo 1 novo (efeitos das entregas,
    observação fora de ordem, estorno e isolamento).
- **Web:** 58 testes unitários, sendo 8 novos (funções das telas de serviço); lint,
  checagem de textos, typecheck e build.
- **`make check`:** todos os projetos passaram.
- **Jobs isolados reproduzidos** (checkout só do módulo, contratos vindos do registro
  local): Sales e web, com typecheck, lint, testes e build.
- **CI local (`make ci-local`):**
  - a primeira passagem falhou só nos espaços: linhas em branco sobrando no fim do
    runbook, do plano e do ADR;
  - a segunda passagem foi limpa.

### Golden path (`scripts/phase53-golden-path.mjs`, 03:38 UTC)

1. **Serviço avulso:**
   - a proposta `QT-0B9EC444` com um serviço é aceita e convertida na ordem de serviço
     `OS-D5C1EF49`, sem pedido de venda;
   - a ordem é iniciada, entregue e aceita;
   - a entrega `SV-C482F373` tem um título em rascunho e a NFS-e número 22 autorizada, e o
     Sales mostra a NFS-e como `authorized`.
2. **Contrato:** o contrato mensal `CTR-5BA3EE38` começa em julho.
   - Rodadas de julho (`01a0e0f2-1bd5-74bd-a015-437f02456910`) e agosto
     (`01a0e0f2-1be3-71d6-bbb8-a7f1e862d4f1`) faturam os dois meses, cada um com título e
     NFS-e autorizada.
   - O aditivo a partir de agosto é recusado (`409`); a partir de outubro é aceito.
   - A mesma chave devolve a mesma rodada, e a rodada nova de agosto
     (`01a0e0f2-a9a6-7ea1-89d3-c451b88c5761`) pula o contrato como `already-billed`.
   - A republicação `4eb7566b-233b-46b3-afc1-817329e92b3d` não cria título, entrada nem
     documento.
   - O crédito de agosto (`not-provided`) deixa o título `cancelled` e a NFS-e
     `cancelled`. Os dois períodos continuam, e julho segue em rascunho.

### Navegador (`web/scripts/services-workflow.e2e.mjs`, 03:35 UTC)

Workspace "Phase 39 validation", operador fiscal, com o cliente e o serviço preparados
pela API. Passos em pt-BR:
1. **Ordem de serviço** `01a0e0ee-ad2c-72a9-a4f4-f4a8dc6408d7`:
   - aberta pela tela, iniciada, entregue em duas vezes e aceita;
   - as duas entregas mostram "rascunho" e "autorizado";
   - "Ver documento" abre a NFS-e na tela do Fiscal, com "Simulação — sem valor fiscal".
2. **Contrato** `01a0e0ef-54bb-7493-8dfe-8a43255d616b`:
   - criado pela tela com preço negociado, começando no mês passado, e ativado;
   - o cronograma mostra "a faturar";
   - na tela de faturamento, a prévia e a rodada mostram o contrato "faturado";
   - na aba Faturados, a NFS-e aparece "autorizado";
   - o crédito "Faturado errado" mostra o título "retirado", a NFS-e "cancelado" e o
     período "creditado" no cronograma.
3. **Clientes → Serviços** lista a ordem e o contrato.
4. **Em inglês:** "Service orders", a aba Billed ("Billed in error"), o cronograma
   ("credited") e "Contract billing" com "Recent runs".

O golden path de mercadorias no navegador (`npm run test:browser`) e o workflow do Fiscal
(`npm run test:browser:fiscal`) foram repetidos com as telas novas. O do Fiscal passou a
filtrar o modelo NF-e 55 na etapa em inglês: as 25 notas mais recentes do workspace já são
NFS-e dos smokes.

### Restauração (`scripts/phase53-restore-check.sh`, 03:40 UTC)

Dump do `horizon_sales` (sha256
`eaabae43371dd787daf6a006f49a248633a509be4c089cbd8b5582eb34c1abe6`) restaurado num PostgreSQL novo. Os
digests das 14 tabelas de serviço do tenant são iguais aos do banco vivo:

| Tabela | Linhas |
|---|---|
| ordens, linhas | 23, 23 |
| entregas, linhas | 32, 32 |
| efeitos das entregas (título, NFS-e) | 0, 16 |
| contratos, revisões, linhas das revisões | 15, 27, 27 |
| suspensões | 3 |
| períodos faturados e linhas | 17, 17 |
| rodadas e itens | 20, 127 |

No banco restaurado:
- reescrever um período faturado, uma linha faturada, um item decidido ou uma entrega é
  recusado;
- o papel da aplicação não consegue alterar uma revisão;
- outro tenant não vê nenhum período faturado.

O script precisou de dois ajustes para rodar num PostgreSQL novo: deixar de fora a extensão
de monitoramento do cluster e criar os papéis `horizon_debug` e `horizon_explain`, que
constam das permissões do dump.

## Fase K fechada

Os critérios de saída do plano de expansão estão provados nas fases 50 a 53:
- **Sem duplicidade:** smokes das fases 50 e 52, e2e do Sales, do Financeiro e do Fiscal, e
  o golden path da fase 53.
- **Sem reescrever período faturado:** testes de domínio das fases 51 e 52, e o golden
  path.

Continua simulado: a NFS-e é emitida só pelo simulador nacional, como na fase J.

## Pendências e limites

- Não há agendador de rodadas: a rodada é iniciada pela tela ou pela API.
- Crédito parcial e substituição da NFS-e (105102) pelo Sales ficam fora.
- O título nasce em rascunho, e o Sales só o conhece depois de lançado. Até lá a tela
  mostra "rascunho", e o link procura a referência na lista de contas a receber.
- A lista de clientes nos seletores cresce com o tenant; o teste de navegador escolhe pelo
  teclado quando a lista passa por baixo dos campos do diálogo.
