# Fase 44 — evidências de XML de entrada e conciliação de compras

Status: **concluída em simulação em 2026-09-26**. O ambiente é só de simulação: as NF-e
de fornecedor usadas aqui são de homologação (`tpAmb = 2`), assinadas por um A1
descartável de teste, e nenhuma autoridade foi consultada. Este registro não inclui
XML integral, certificado, chave privada ou dados pessoais.

Plano: [fiscal-phase44-implementation-plan.md](fiscal-phase44-implementation-plan.md).
Decisão: [ADR 0051](adr/0051-supplier-xml-is-evidence-not-an-operational-fact.md).

## O que foi entregue

- **Verificação do XML** (`fiscal/src/nfe55/inbound.ts`):
  - O corpo tem limite de 1 MiB, lido em streaming.
  - Recusa `DOCTYPE`, `ENTITY`, instruções de processamento, UTF-8 inválido e XML
    malformado.
  - Valida a `NFe` contra o PL 010f fixado. Exige modelo 55, versão 4.00,
    `tpNF = 1` e `finNFe = 1`.
  - A chave de acesso deve conferir campo a campo com o conteúdo, e o destinatário
    deve ser o CNPJ do emitente do tenant.
  - A assinatura deve referenciar `#NFe<chave>`, e a raiz do CNPJ do certificado deve
    ser a do emitente. O certificado precisa estar válido na emissão.
  - Um `nfeProc` precisa ter exatamente a `NFe` e um protocolo 100/150 do mesmo
    `digVal`.
  - Tudo o que é gravado é lido do `infNFe` autenticado pela assinatura.
- **Evidência guardada:**
  - os bytes originais cifrados no armazenamento de artefatos (`inbound_xml`);
  - o snapshot da nota selado com chave do tenant;
  - `signature: valid-unanchored` e `authorityStatus: unverified` explícitos.
- **Duplicatas.**
  - Mesmo conteúdo assinado (inclusive a mesma nota com e sem `nfeProc`): a importação
    existente é devolvida.
  - Conteúdo diferente com a mesma chave vira conflito: fica guardado e visível, e
    bloqueia a conciliação até ser dispensado com motivo.
- **Projeções só de leitura:**
  - pedido aprovado, recebimento e devolução de Compras;
  - conta a pagar lançada ou estornada do Financeiro, só de origem `purchase-receipt`.

  O Fiscal nunca escreve nesses módulos.
- **Fornecedor por índice cego:** HMAC do CNPJ com chave por tenant. A exclusão da Party
  apaga o índice. A CLI `phase44:reindex-parties` indexa as Parties projetadas antes da
  fase.
- **Proposta e conciliação:**
  - A proposta usa o mapeamento lembrado `(fornecedor, cProd) → item, fator` ou, sem
    ele, o único item aberto com o mesmo NCM. Preenche os recebimentos mais antigos
    primeiro.
  - O servidor recalcula a comparação no commit. A alocação nunca passa do recebido
    menos o devolvido (serviço com lock e gatilho no banco).
  - Diferenças só entram como `overridden`, com motivo. Há uma conciliação imutável
    por importação, com `Idempotency-Key`.
  - O evento `fiscal.inbound.matched` sai pelo outbox.
- **API** (papéis `reviewer`/`admin`):
  - `POST /imports`, `GET /imports`, `GET /imports/:id` e `GET /imports/:id/xml`;
  - `POST /imports/:id/conflict-dismissals` e `POST /imports/:id/reconciliation`.
- **Contratos** `@horizon/contracts` 0.33.0: esquemas HTTP de importação e o evento
  `fiscal.inbound.matched` v1. A chave de acesso é nula quando o emitente é pessoa
  física, porque ela embute o CPF. Todos os módulos passam a fixar a 0.33.0.
- **Banco:** a migração `0046_phase44_inbound_reconciliation.sql` remove os
  placeholders vazios da fase 40 (com trava se houver linhas) e cria as tabelas com
  RLS forçada e gatilhos de imutabilidade, alocação e bloqueio por conflito.

## Critérios de saída

| Critério do roteiro | Evidência |
|---|---|
| Reimportação e replay do broker não criam segundo recebimento nem conta a pagar | e2e `reconciles an XML imported after its receipt once…`: reimportação (com e sem `nfeProc`), replay dos eventos de recebimento e conta a pagar e repetição do commit. Resultado: 1 recebimento, 1 conta a pagar, 1 documento, 1 conciliação e um único `fiscal.inbound.matched` no outbox. Stack local: o mesmo evento de recebimento reenviado no RabbitMQ deixou 1 recebimento, 1 conta a pagar e estoque +6. |
| Pedido recebido em parte casa com uma de várias notas | e2e `matches a partially received order…`: recebimentos R1 (6) e R2 (4) do mesmo pedido casam com as notas A e B. A nota C, que pede de novo a quantidade de R1, é recusada pelo serviço (`ALLOCATION_INVALID`) e pelo gatilho do banco. |
| XML antes ou depois do recebimento, com as duas coisas e a decisão preservadas | e2e `keeps an XML that arrived first open…`: a nota importada antes fica aberta sem proposta. Chegado o recebimento, a proposta aparece. A diferença de preço exige motivo (`OVERRIDE_REQUIRED`) e fica como `overridden`. Devolução e estorno posteriores aparecem em `laterChanges`, sem alterar a decisão. |
| Dois tenants com o mesmo fornecedor não se veem | e2e `never shows one tenant…`: leitura, XML, listagem e conciliação cruzadas dão 404/vazio. O mesmo CNPJ gera digests diferentes. Uma nota endereçada a outro tenant é recusada (`RECIPIENT_MISMATCH`). A exclusão da Party remove o candidato só no tenant dela. |
| Duplicata conflitante visível e bloqueada | e2e `shows a conflicting duplicate…`: a cópia com outro conteúdo sob a mesma chave dá 409 e é registrada uma vez. A importação fica `blocked` e a conciliação dá `BLOCKED` até a dispensa com motivo. |

## Verificação (2026-09-26)

- Unitários do fiscal: 121 testes. Incluem verificador de XML (7), motor de
  comparação (8) e rotas de importação (4).
- e2e do fiscal com PostgreSQL real: 34 testes. São 5 novos da fase 44, e os 29 das
  fases anteriores continuam passando.
- Contratos: 87 testes. Gate de compatibilidade, pins (`@horizon/contracts@0.33.0`
  em todos os módulos), links da documentação e os 21 testes de scripts passaram.
- `make check` passou em todos os projetos, e o build do fiscal também.

### Smoke no stack local via Kong

`scripts/phase44-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614` (Fiscal
reconstruído com a migração 0046). Passos:
- um fornecedor novo com perfil fiscal em Parties;
- pedido de 10 unidades em Compras (aprovado por outra pessoa) e recebimento parcial
  de 6;
- conta a pagar classificada, aprovada por outra pessoa e lançada;
- NF-e do fornecedor gerada por `phase44:supplier-invoice`, importada duas vezes
  (201 e depois 200 `duplicate`);
- proposta automática pelo NCM, conciliação `matched` e repetição com a mesma chave
  (200, mesmo id);
- o evento `procurement.receipt.recorded` capturado e reenviado no RabbitMQ.

Depois: 1 recebimento no pedido, 1 conta a pagar lançada, estoque +6, importação
`reconciled` e `fiscal.inbound.matched` entregue pelo outbox.

| Execução | Importação | Conciliação | `payableTitleIds` no commit |
|---|---|---|---|
| 18:08 UTC | `956407e6-d799-4875-a41d-f0227afb8785` | `48f9973a-4c8e-4d1c-bb7d-8500461d9bf8` | a conta lançada |
| 18:12 UTC | `e86f0298-b512-4ebd-a9a2-0c35a1226f26` | `901d32ee-95b7-4d36-98a3-77fef19b088d` | vazio |

Na segunda execução, o commit chegou antes de o Fiscal projetar o
`financial.payable.posted`. `payableTitleIds` é um retrato do que o Fiscal conhecia no
commit, não um vínculo mantido depois. A conta a pagar continuou única.

## Achados durante a fase

- **Linhas de recebimento colidiam.** Recebimentos parciais do mesmo pedido repetem o
  `lineId` da linha do pedido. O motor indexava só por `lineId` e somava o saldo dos
  dois recebimentos. Agora a chave é recebimento + linha, e há teste para isso.
- **Conteúdo fora da assinatura.** Um `infNFe` extra ao lado da nota dentro do
  `nfeProc` passava, porque o XSD só cobre a `NFe`. Agora o `nfeProc` precisa ter
  exatamente `NFe` e `protNFe`.
- **Guarda de projeção.** O gatilho que protege as projeções referenciava colunas de
  outra tabela, e o SQL não garante curto-circuito. Foi reescrito por coluna mutável.

## Limites conhecidos

- Status na autoridade (distribuição DF-e ou consulta de protocolo) e cadeia
  ICP-Brasil não são verificados. Cada importação diz isso.
- Recebimentos anteriores à fase não foram projetados. Casar notas com eles exige
  reprocessar os fatos de Compras. Uma devolução desses recebimentos é ignorada.
- Notas de devolução, complementares e de ajuste (fase 45), CT-e e NFS-e de entrada
  ficam fora. Desfazer uma conciliação também. As telas são da fase 48.
