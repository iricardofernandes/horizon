# Fase 43 — evidências de homologação NF-e 55/SP

Status: **pendente**. Este registro não atesta emissão real. Preencher somente com
evidências do emissor credenciado e revisão Fiscal independente. Não incluir XML
integral, certificado, chave privada, dados pessoais do destinatário ou segredos.

## Verificação local (2026-09-25)

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
  WSDL, credencial, fontes efetivas e interpretação fiscal continuam pendentes.

## Tupla aprovada

| Campo | Evidência |
|---|---|
| Tenant e estabelecimento | Pendente |
| CNPJ do emitente (mascarado) e credenciamento SP | Pendente |
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
