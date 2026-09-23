# Fase 43 — evidências de homologação NF-e 55/SP

Status: **pendente**. Este registro não atesta emissão real. Preencher somente com
evidências do emissor credenciado e revisão Fiscal independente. Não incluir XML
integral, certificado, chave privada, dados pessoais do destinatário ou segredos.

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
