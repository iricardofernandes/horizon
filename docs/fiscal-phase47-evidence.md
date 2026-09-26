# Fase 47 — evidências da NFS-e nacional

Status: **concluída em simulação em 2026-09-26**.
- Toda NFS-e desta fase foi gerada pelo simulador determinístico da Sefin Nacional
  (`nfse-national-simulator-v1`).
- Nenhuma autoridade foi consultada, e nenhuma API nacional foi chamada.
- Este registro não inclui XML integral, chave de acesso, CNPJ de tomador, certificado ou
  chave privada.

Plano: [fiscal-phase47-implementation-plan.md](fiscal-phase47-implementation-plan.md).
Decisão: [ADR 0054](adr/0054-national-nfse-is-keyed-by-municipality-and-reconciled-by-dps.md).
Fontes: [manifesto da fase 47](fiscal-phase47-source-manifest.json) (XSD 1.01, Anexos I, II,
A, B e C, manual das APIs e lista de municípios aderentes de 18/09/2026, com SHA-256).

## O que foi entregue

- **Perfil fiscal de serviço** (`fiscal_service_profiles`): revisões imutáveis por item de
  serviço do Catalog, com código de tributação nacional, NBS e tributação do ISS.
  - Os códigos são conferidos contra o extrato fixado dos Anexos B.
  - O item precisa ser um serviço ativo no Catalog.
  - A classificação de mercadorias (NCM) não mudou.
- **Origem de serviço** (`POST /fiscal/service-origins`): congela, cifrada e com digest,
  os fatos da prestação:
  - estabelecimento, revisões do emitente e do tomador;
  - item de serviço e revisão do perfil;
  - **data de competência**, valor e descrição.

  Uma chave de origem opcional (módulo, tipo, id, período) é única por tenant. Os mesmos
  fatos voltam a mesma origem; fatos diferentes dão `SOURCE_KEY_CONFLICT`. É por ela que
  os períodos de contrato da fase K vão entrar.
- **Registro municipal versionado:**
  - uma versão revisada da lista oficial de aderentes, com a linha de origem de cada
    município;
  - São Paulo (linha 4301) tem convênio ativo e emissor nacional desde 22/12/2025, e é
    `national`;
  - Campinas (linha 3845) tem convênio ativo, mas emissor nacional "Não", e é
    `unsupported` (E0039);
  - um município ausente ou uma versão sem revisão também são `unsupported`.
- **Capacidade por município:** modelo `nfse`, jurisdição `municipality` 3550308, operação
  `service-provision`, fixture `rtc-v0057-nfse-service-provision-2026-01`.
  - O município não suportado é recusado ao congelar a origem, na prontidão, na emissão e
    pelo simulador.
- **DPS 1.01** (`fiscal/src/nfse/`):
  - identificador `DPS` + município + `2` + CNPJ + série (5) + número (15), vinculado
    antes do envio;
  - `prest` com CNPJ, IM e `regTrib` (`opSimpNac` 1, `regEspTrib` 0), sem nome nem
    endereço (E0121, E0128);
  - `toma` com CPF ou CNPJ e endereço nacional;
  - `serv` com `cTribNac`, `cNBS` e local de prestação;
  - `valores` com `tribISSQN` 1 e `tpRetISSQN` 1, **sem `pAliq`** (E0617);
  - `IBSCBS` com `cIndOp` 100301, CST 000 e `cClassTrib` 000001;
  - assinatura XML-DSig sobre `infDPS` e validação no `DPS_v1.01.xsd`.
- **Cálculo:** ISS pelo parâmetro municipal revisado (2%, leitura provisória) e CBS/IBS
  pelas alíquotas de referência RTC V0057, escolhidos pela competência. A explicação
  mostra as duas fontes. Os valores da NFS-e gerada são conferidos com o cálculo travado
  (`calculation_matches`).
- **Simulador da Sefin Nacional:**
  - geração síncrona da NFS-e 1.01 (válida no `NFSe_v1.01.xsd`), com chave de 50
    dígitos, `nNFSe`, `dhProc`, alíquota aplicada, `vISSQN` e o grupo IBS/CBS;
  - consulta por DPS (`GET /dps/{id}`) e pela chave;
  - regras E0004, E0006, E0008, E0010, E0014, E0015, E0016, E0037–E0039, E0042, E0617
    e E0822.
- **Resposta perdida:** depois de um envio incerto, o worker consulta a DPS antes de
  qualquer reenvio. Só uma DPS que a Sefin nunca recebeu é enviada de novo; um reenvio
  ingênuo daria E0014.
- **Cancelamento (101101):** pedido assinado e validado no `pedRegEvento_v1.01.xsd`, só
  dentro da janela municipal contada do `dhProc`; depois dela,
  `CANCELLATION_WINDOW_ELAPSED`.
- **Substituição (105102):** nova DPS com `subst`.
  - Tomador, competência, código do serviço e local não mudam (E0058, E0060).
  - Ao gerar o substituto, o original vira `cancelled` na mesma transação.
  - Um original tem no máximo um substituto vivo e não pode ser cancelado enquanto a
    substituição está pendente.
- **Evento:** `fiscal.service-document.simulation-outcome` v1 (autorizada, rejeitada ou
  cancelada), com origem, chave de origem, município, competência e o vínculo de
  substituição. Não leva chave de acesso, dados do tomador nem XML, e não nomeia dono de
  estoque ou dinheiro.
- **Contratos 0.36.0:** 16 esquemas HTTP e 1 evento novos, todos aditivos.

## Critérios de saída

| Critério do roteiro | Evidência |
|---|---|
| Uma tupla nacional com emissão, consulta e correção/cancelamento suportados | e2e `issues an NFS-e…`, `reconciles a lost response…`, `substitutes an NFS-e once…`; smoke no stack local (abaixo) |
| Município não suportado não chega ao endpoint de transmissão | e2e `never lets an unsupported municipality reach the national system`: o simulador contado recebe 0 envios e 0 consultas; o registro recusa Campinas (E0039) e o Rio de Janeiro (ausente) |
| Resposta perdida reconciliada por DPS antes de reenviar | e2e: `response:unknown` seguido de `consultation:authorized` com 1 envio e 1 consulta; no smoke, idem |
| Eventos duplicados de período de contrato mapeiam para uma origem | e2e `maps one owner source key…`; smoke: mesma origem ao repetir, `SOURCE_KEY_CONFLICT` com outro valor |
| Versões das fontes do ISS e do IBS/CBS rastreáveis na explicação | e2e (componente ISS com `parametros_municipais/3550308`) e smoke (`/calculation/explanation`) |
| Testes dos modelos 55 e 65 inalterados e verdes | os 45 e2e anteriores passaram sem alteração |

## Verificação

- **Unitários do fiscal:** 166 passando, sendo 18 novos:
  - DPS e pedido de cancelamento válidos no XSD;
  - identificadores do Anexo I;
  - simulador com a NFS-e e os eventos válidos no XSD;
  - rotas da API;
  - cenário aprovado, que confere o digest do manifesto.
- **E2e do fiscal com PostgreSQL real:** 50 passando, sendo 5 novos da fase 47. O log da
  execução completa tem SHA-256
  `c3e8d30f19b1e484e2028663956e558c5d23e2c2c30be1da8073c49b79ce3e2b`, usado como
  evidência na ativação local.
- **Contratos:** 100 testes. Gate de compatibilidade da 0.35.0 para a 0.36.0: 0 quebras e
  17 adições.
- **Também passaram:**
  - pins (`@horizon/contracts@0.36.0` em todos os módulos);
  - links da documentação;
  - 21 testes de scripts;
  - fronteiras;
  - `make check`.

### Smoke no stack local via Kong

`scripts/phase47-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`, emitente em
São Paulo com CNPJ numérico e lucro real. Preparação:
- o Fiscal foi reconstruído com a migração 0049;
- `phase47:rollout` foi aplicado com a evidência acima;
- o perfil de emissão ganhou o bloco `service`;
- `FISCAL_NFSE_SCHEMA_PATH` passou a apontar para o XSD fixado.

Passos:
1. **Registro:** São Paulo `national`; Campinas `unsupported` (E0039). O catálogo de
   tipos passa a dar `cancellation` para `nfse`.
2. **Serviço:** item de serviço criado no Catalog e perfil fiscal revisão 1 (010101,
   NBS 115022000).
3. **Tomador:** empresa com CNPJ e endereço nacional em São Paulo.
4. **Origem:** com chave de período de contrato; repetida devolve a mesma origem, e outro
   valor dá `SOURCE_KEY_CONFLICT`.
5. **NFS-e gerada:**
   - DPS `DPS35503082<cnpj>00001…`, sem `pAliq`;
   - a NFS-e tem `cTribNac` 010101, `cNBS`, `pAliqAplic` 2.00, `vISSQN` 30.00 e
     `cStat` 100;
   - a explicação do cálculo cita o parâmetro municipal e a calculadora RTC.
6. **Substituição:** nova origem com valor revisado; o substituto é gerado com `subst`, o
   original fica `cancelled` e o evento 105102 é guardado.
7. **Cancelamento** do substituto pelo evento 101101: `cancelled`.
8. **Eventos:** quatro `fiscal.service-document.simulation-outcome` entregues (duas
   autorizações e dois cancelamentos).

O simulador local roda com `timeout-after-accept`, então cada geração e cancelamento
passou por resposta incerta e consulta.

| Execução | NFS-e | Número | Observações | Substituta | Número | Eventos (resultado:entregue) |
|---|---|---|---|---|---|---|
| 21:15 UTC | `3de571ac-fe75-40e9-a58f-a9b64ab29554` | 1 | response:unknown, consultation:authorized | `02ff2d9b-ee37-4b68-a456-9be7f41f7459` | 2 | 2 autorizações e 2 cancelamentos, entregues |
| 21:16 UTC | `140b3c09-2c9b-4127-8951-0cb2719a9f10` | 3 | response:unknown, consultation:authorized | `4b276106-fc46-48e1-ac27-4b67316b815f` | 4 | 2 autorizações e 2 cancelamentos, entregues |
| 21:18 UTC | `7f267f19-b05d-45cb-b3a4-31e6c3ff9a84` | 5 | response:unknown, consultation:authorized | `c5cc9fd3-45be-4fed-bf25-adb3f7809305` | 6 | 2 autorizações e 2 cancelamentos, entregues |

A ordem dos dois eventos da substituição varia entre as execuções, porque saem na mesma
transação (mesmo `created_at`).

## Pendências e limites

- **Produção restrita e produção não foram exercitadas.** Elas pedem:
  - o A1 ICP-Brasil do estabelecimento: o Swagger da Sefin Nacional e do ADN e os
    parâmetros municipais respondem 403 sem certificado;
  - a confirmação dos algoritmos de assinatura (a simulação usa RSA-SHA256);
  - um adaptador HTTP da Sefin Nacional;
  - revisão fiscal.

  Continuam como gate de ativação `homologated`, como nas fases 43 a 46.
- **Leituras provisórias do dono do workspace:** ISS de 2% para 010101 em São Paulo,
  janelas de cancelamento e substituição de 30 dias, `cIndOp` 100301 e `cClassTrib`
  000001. Os parâmetros oficiais vêm de `/parametros_municipais`.
- **Defeito do XSD 1.01:** o padrão de `TSSerieDPS` tem âncoras literais. A validação
  remove esses dois caracteres em memória, depois de conferir o digest do pacote.
- **Fora do escopo:**
  - municípios com sistema próprio;
  - prestador do Simples Nacional ou MEI;
  - retenção, deduções, benefícios, exportação e obra;
  - emissão pelo tomador ou intermediário;
  - eventos de manifestação e análise fiscal;
  - o DANFSe, que é gerado pelo ADN.
- **Contratos de serviço e ordens de serviço** ficam para a fase K, pela chave de origem.
- **Telas** ficam para a fase 48.
