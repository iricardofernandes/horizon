# Fase 43 — evidências de homologação NF-e 55 por UF

Status: **concluída em simulação em 2026-09-26**. O ensaio completo rodou contra um
autorizador emulado para SP (SEFAZ-SP) e para RJ (SVRS). As seções do autorizador
oficial continuam **pendentes**: dependem de um emitente credenciado, do A1 real e de
revisão Fiscal independente, e o ambiente atual é só de simulação. Este registro não
atesta emissão real. Não incluir XML integral, certificado, chave privada, dados
pessoais do destinatário ou segredos.

## Ensaio emulado multi-UF (2026-09-26)

Decisão do dono do workspace em 2026-09-26: o ambiente é só de simulação, e a fase
43 fecha com o ensaio completo contra um autorizador emulado. A ativação
`homologated` fica para quando houver emitente credenciado. A arquitetura passou a
seguir a UF e o município do emitente de cada tenant
([ADR 0050](adr/0050-fiscal-authorizer-follows-issuer-jurisdiction.md)).

- **Jurisdição pelo cadastro.** A UF e o código IBGE do município vêm do endereço do
  emitente. Um município que não pertence à UF é recusado. `cUF`, `cMunFG`, `cOrgao`
  e o prefixo da chave saem desse endereço. Venda normal continua intraestadual.
- **Autorizador por UF.** A relação oficial UF→autorizador e as URLs de homologação
  dos 12 autorizadores (10 SEFAZ próprias, SVRS e SVAN) foram lidas do Portal Nacional
  da NF-e em 2026-09-26. A página de serviços tinha SHA-256 `cbc90bbc…6aec`; como é
  HTML dinâmico, o digest identifica a leitura e não fixa a fonte. O transporte só
  aceita um conjunto publicado completo. O digest do conjunto SP é o mesmo de antes.
- **A1 por tenant e estabelecimento.** O worker e os CLIs resolvem a UF pelo grant e
  pela capability de cada troca. Carregam o A1 cifrado do estabelecimento e as
  operações SOAP revisadas do autorizador daquela UF. Um único worker atende tenants
  de estados diferentes.
- **Banco.** A migração `0045_phase43_uf_authorizers.sql` troca os oito gatilhos
  fixos em SP por `fiscal_nfe_uf_code()`. Exige UF válida em capability 55/65 e chave
  de acesso com o código da UF da capability. Acrescenta `authority` (`official` |
  `emulated`) ao grant e recusa troca emulada como evidência de ativação.
- **Emulador.** `SefazHomologationEmulator` (CLI `phase43:emulator`, que exige
  `FISCAL_ALLOW_SEFAZ_EMULATOR=true`) responde aos cinco serviços nos caminhos
  oficiais e exige mTLS com o CNPJ ICP-Brasil do emitente. O transporte envia os
  mesmos bytes a uma rota de loopback e verifica o hostname oficial no TLS. A rota
  muda o digest dos endpoints e a autoridade do grant.

`test/phase43-drill.e2e-spec.ts` (PostgreSQL isolado, adapter e transporte reais,
PL 010f/009p/010d oficiais) passou nos três casos:

| Caso | Resultado no ensaio emulado |
|---|---|
| Estado do serviço | `107` para SP (`cUF` 35) e RJ via SVRS (`cUF` 33), decisão `available` |
| Autorização normal | `103` com recibo, consulta de recibo `104`/`100`, decisão `authorized`; um único envio por chave |
| NF-e por UF e município | XML assinado com `cUF` 35/`cMunFG` 3550308 (São Paulo) e `cUF` 33/`cMunFG` 3304557 (Rio de Janeiro); chave com o CNPJ do A1 de cada tenant |
| A1 por tenant | Cada emulador só viu o CNPJ do certificado do próprio tenant no mTLS |
| Rejeição de negócio | `104` com `225`, decisão `rejected`; nova consulta recusada por decisão terminal |
| Código não revisado | `104` com `539`, decisão `unknown` para reconciliação do operador |
| Resposta perdida | Conexão encerrada após autorizar; duas retomadas recusadas como incertas; um envio; consulta por protocolo `100` → `authorized` |
| Falha temporária | HTTP 503; retomada recusada; consulta `217` → `unknown`; nenhum reenvio |
| Cancelamento `110111` | `128`/`135` com protocolo, decisão `cancelled`, para os dois tenants |
| DANFE de homologação | Gerado a partir do XML assinado e do protocolo retidos |
| Verificação de artefatos | `HomologationRestoreVerifier` conferiu as quatro trocas de cada documento |
| Isolamento | Adapter RJ com transporte SP recusado; UF inválida recusada; transporte oficial com grant emulado recusado; evidência emulada recusada na ativação; nada selecionado pelo worker |

Também passaram, em 2026-09-26: `make check` (todos os projetos), 102 testes
unitários e 29 testes de integração do Fiscal. Os 29 incluem os ensaios de
restauração com `pg_dump`/`pg_restore` do registro de 2026-09-25.

Achados do ensaio:

- **Rota de loopback.** Em `https.request(url, options)`, o `hostname` da URL
  oficial prevalece sobre `host`. A primeira versão da rota tentou sair para o IP
  real da SEFAZ-SP e só falhou porque a porta do emulador não existe lá. A correção
  fixa `hostname` e `servername`, e o e2e prova que o tráfego chega ao emulador.
- **Envelope SOAP.** O adapter envolve `nfeDadosMsg` num elemento com o nome da
  operação, e o emulador reproduz esse formato. A WSDL oficial ainda não foi revisada
  (HTTP 403 sem A1). Se ela publicar `nfeDadosMsg` direto no `Body`, adapter e
  emulador mudam juntos antes do primeiro envio real.

## Verificação local (2026-09-25)

- O app agora apresenta o cadastro de A1 `.pfx`/`.p12` com senha por estabelecimento
  para administradores Fiscal. Um certificado de laboratório com CNPJ sintético
  validou extração, persistência cifrada, troca da credencial ativa e isolamento
  entre tenants em PostgreSQL. O worker e os comandos de homologação selecionam
  a credencial pelo tenant, estabelecimento do documento e fingerprint vinculado
  à troca; o simulador continua disponível sem certificado real. Este teste não
  comprova credenciamento ICP-Brasil nem emissão na SEFAZ.

- Commit `02ecd8f`: vínculo imutável dos dois pacotes XSD de resposta, seleção do
  worker somente após ativação, bloqueio de novos envios após desativação e
  validação de correlação da resposta SOAP.
- Fiscal: typecheck, lint, build, 93 testes unitários e 25 testes de integração
  passaram localmente. O teste de integração usa PostgreSQL e RabbitMQ isolados;
  não chama a SEFAZ.
- `make verify-phase43-sources` conferiu os seis arquivos candidatos retidos e
  os XSDs de resposta extraídos por SHA-256.
- Um teste local fez `pg_dump` e `pg_restore` em outro PostgreSQL, copiou os objetos
  criptografados e conferiu os digests. Na instância restaurada, uma troca iniciada
  sem resposta permaneceu sem reenvio, uma resposta bruta foi interpretada e a
  capability desativada não selecionou novos envios. Isso não substitui a restauração
  do ensaio com o emissor real.
- Outro teste local restaurou o banco do Sales em um PostgreSQL isolado no estado
  `packed`, sem autorização de produção. Após a restauração, tanto o comando de
  expedição quanto a proteção SQL continuaram a bloquear o envio. A suíte de 13
  testes de integração do Sales passou com essa verificação.
- O PDF de homologação local usa um título próprio e a marca "SEM VALOR FISCAL"
  em cada página; sua geração exige XML assinado retido e protocolo autorizado.
  O arquivo restaurado foi conferido pelo verificador de artefatos.
- A resposta interpretada cria um evento `fiscal.document.homologation-observed` v1
  na mesma transação da observação imutável. O payload contém ambiente de
  homologação, `fiscalValue: false`, decisão e digests, sem XML bruto. A integração
  local confere publicação pelo relay e ausência de duplicata ao reprocessar a
  mesma resposta. Todos os consumidores foram fixados em `@horizon/contracts@0.32.0`.
- A [lista oficial de serviços da SEFAZ-SP](https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/URL-WEBSERVICES.aspx)
  ainda apresentava as cinco URLs candidatas de homologação 4.00 em 2026-09-25.
  O GET de WSDL com a raiz TLS de fingerprint já registrada continuou em HTTP 403.
  Há agora um comando de coleta por mTLS testado contra servidor local; WSDL,
  credencial, fontes efetivas e interpretação fiscal continuam pendentes.
- `node scripts/ci-local.mjs` passou em 2026-09-25, incluindo os testes de
  integração isolados dos serviços, validação dos contratos gerados, limites entre
  módulos e varredura de segredos. O ensaio de SEFAZ e o CI remoto seguem pendentes.
- Uma instalação limpa do Sales resolveu `@horizon/contracts@0.32.0` pelo registro
  local; o typecheck e os 13 testes de integração do Sales passaram com esse pacote.
- `node scripts/ci-local.mjs --full` passou em 2026-09-25: instalações limpas,
  verificações de código, testes de integração e build das 12 imagens Docker. O
  caminho dourado no navegador, gateway e Terraform pertencem a jobs separados.
- `make demo` passou duas vezes no ambiente local em 2026-09-25. O comando
  `make test-phase10` passou no Chromium com trace correlacionado entre Web,
  gateway, Sales, Inventory, Financial e Webhooks. Isto verifica o caminho dourado
  existente, não uma transmissão de homologação.
- O workflow manual `phase43-homologation.yml` foi preparado para executar uma
  troca por vez em runner e environment dedicados. O resumo de log omite recibo,
  protocolo e XML; a checagem local de 21 testes de scripts passou. O workflow
  ainda não foi executado com credencial real nem aprovado por revisor Fiscal.

## Tupla aprovada para o autorizador oficial

Pendente até existir um emitente credenciado; nada nesta seção vem do emulador. A
tupla é uma por tenant, estabelecimento e UF: a UF do endereço do emitente escolhe o
autorizador.

| Campo | Evidência |
|---|---|
| Tenant e estabelecimento | Pendente |
| CNPJ do emitente (mascarado), UF e credenciamento no autorizador | Pendente |
| Operação normal de venda, série e faixa de números | Pendente |
| Manifesto de fontes e interpretação revisada | Pendente |
| Pacotes de regras e fixture aprovados | Pendente |
| Arquivos XSD de documento, resposta e evento aprovados | Pendente |
| WSDL, operações e URLs de homologação revisados | Pendente |
| Impressão digital do certificado e raiz TLS | Pendente |
| Capability, reviewer e grant temporário | Pendente |
| IDs vinculados de autorização, consulta autorizada e cancelamento | Pendente |

## Ensaios no autorizador oficial

Para cada caso, registrar horário com fuso, operador, ID do documento e da troca,
serviço, digest do endpoint, digest do WSDL, digest do XML assinado e da requisição,
digest da resposta, `cStat` de lote/documento/evento, decisão interna e referência
mascarada do recibo ou protocolo. Confrontar o resultado com o portal oficial.

| Caso | Resultado e confronto |
|---|---|
| Estado do serviço | Pendente |
| Autorização normal | Pendente |
| Rejeição de negócio | Pendente |
| Lote recebido e consulta de recibo | Pendente |
| Resposta perdida e consulta por protocolo | Pendente |
| Falha temporária ou resultado incerto sem reenvio | Pendente |
| Cancelamento `110111` do protocolo autorizado | Pendente |

## Isolamento e recuperação

| Gate | Evidência |
|---|---|
| Homologação não libera expedição, estoque ou financeiro | Pendente |
| Outro tenant, UF, modelo e operação continuam bloqueados | Pendente |
| Backup restaurado de PostgreSQL e artefatos criptografados | Pendente |
| `phase43:restore-verify` confere todos os digests | Pendente |
| Troca pendente retomada sem duplicar autorização | Pendente |
| Capability desativada e comandos pendentes drenados | Pendente |
| Transmissão em produção permanece desabilitada | Pendente |

## Aprovação

- Operador do ensaio: pendente.
- Revisor Fiscal independente: pendente.
- Data, decisão e justificativa: pendente.
- Evidência de CI e versão do commit: pendente.

Somente após todos os gates comprovados a capability poderá receber a ativação
`homologated`. A ativação de produção permanece fora do escopo desta fase.
