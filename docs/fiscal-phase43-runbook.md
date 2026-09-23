# Fase 43 — runbook da NF-e 55 em homologação SP

**Estado:** preparação operacional. A [evidência de homologação](fiscal-phase43-evidence.md)
ainda está pendente. Nenhum resultado de simulação autoriza a ativação `homologated`.

## Escopo e responsáveis

Executar somente para o tenant, estabelecimento, série, operação de venda normal e
emissor SP aprovados no [manifesto da fase](fiscal-phase43-source-manifest.json).
O operador executa os comandos internos. O revisor Fiscal, distinto do autor/importador,
aprova fontes, regras, perfil, numeração, resultados do portal e o pacote final.
Sales mantém a expedição configurada bloqueada: homologação não produz autorização
de produção nem libera estoque ou financeiro.

## Pré-condições

1. Confirmar CNPJ/credenciamento, custódia e validade do certificado, cinco URLs de
   homologação, WSDL, operações SOAP e raiz TLS. Registrar seus digests revisados.
2. Reter e revisar os bytes dos pacotes de regras e dos XSDs. Definir capability
   separada da simulação, com `sourceManifestDigest`, `schemaPackageDigest` e fixture.
3. Registrar a capability e sua revisão pelo comando `phase42:capability` com ações
   `register` e `review`. Registrar faixa, pacotes de cálculo, perfil de emissão e
   XSD de evento pelos comandos `phase43:number-range`,
   `phase43:calculation-approval`, `phase43:issuance-profile` e
   `phase43:event-schema-approval`. Não ativar a capability ainda.
4. Conferir que `DATABASE_URL`, `FISCAL_ARTIFACT_KEY_HEX`,
   `FISCAL_ARTIFACT_BUCKET` e `FISCAL_ARTIFACT_REGION` apontam ao mesmo ambiente
   isolado. `FISCAL_ARTIFACT_ENDPOINT` é opcional. Montar chave privada e certificado
   fora do repositório; nunca passá-los em JSON, logs ou evidências.
5. Executar build, testes unitários/e2e e migrações em ambiente de ensaio. Fazer
   backup consistente do banco e dos objetos criptografados antes do teste real.

## Sequência por documento

1. Congelar a origem com Sales em `packed` e criar o draft interno. Conferir o
   tenant, estabelecimento, documento, série e capability aprovada antes de prosseguir.
2. Criar um grant com `phase43:grant -- --file <json>`. O arquivo contém tenant,
   documento, capability, digests de endpoint/WSDL/certificado, operador e expiração
   em até duas horas. Registrar o grant ID na evidência, sem armazenar credenciais.
3. Validar readiness com `phase43:readiness` usando esse grant. Conferir no
   resultado capability, pacote de regras e digest de reconciliação. Um cálculo
   não suportado encerra o ensaio desse documento.
4. Opcionalmente executar `phase43:status` com um novo exchange ID. Confirmar
   `cStat` e digest da resposta em `phase43:observations`.
5. Executar `phase43:issuance-prep` com um exchange ID estável. Conferir chave de
   acesso, número, digest do XML assinado e `sent: false`. Não trocar o exchange ID
   ao repetir a preparação. Conferir o número reservado antes de qualquer envio.
6. Executar `phase43:exchange-resume` para esse exchange ID. Esta ação pode chamar
   a SEFAZ uma vez. Conferir o estado por `phase43:observations` e comparar os
   códigos, recibo e protocolo com o portal oficial antes de classificar o caso.
7. Para `pending` ou envio iniciado sem resposta, executar `phase43:consult` com
   **novo** exchange ID e o documento original. A consulta seleciona recibo ou
   protocolo a partir da evidência persistida. Repetir apenas dentro do orçamento
   de dez consultas. Nunca preparar uma segunda autorização para o documento.
8. Após protocolo autorizado observado, executar `phase43:cancellation-prep` com
   justificativa e horário explícitos. Conferir `sent: false`, então executar
   `phase43:exchange-resume` para o exchange ID do evento. Comparar o `128/135`
   observado e o protocolo com o portal. Registrar digests, não XML protegido.

Usar documentos separados para autorização normal, rejeição de negócio e falha
temporária. O caso de resposta perdida exige consulta e reconciliação manual se
continuar incerto; um `not_found` isolado não libera reenvio.

## Estados e recuperação

| Estado em `phase43:observations` | Ação |
|---|---|
| `prepared` | `phase43:exchange-resume` pode iniciar o único envio. |
| `send_started` | Tratar como incerto; consultar. Repetir o envio é bloqueado. |
| `raw_unparsed` | Usar `phase43:reparse`; lê os bytes armazenados sem rede ou certificado de assinatura. |
| `observed` com `pending` | Consultar pelo recibo/protocolo indicado. |
| `observed` com `authorized`, `rejected` ou `cancelled` | Registrar e confrontar com o portal; não reenviar. |
| Código ou combinação `unknown` | Parar e submeter à reconciliação do operador/revisor. |

Se o grant, certificado ou raiz TLS expirar, parar novas transmissões. Uma resposta
bruta já armazenada pode ser interpretada por `phase43:reparse`. Trocas iniciadas
sem resposta continuam incertas e precisam de consulta com grant/credencial válidos.
Uma falha de objeto criptografado ou digest impede a continuação até restaurar os
bytes corretos. Não criar nova numeração para contornar falha de recuperação.

## Monitoramento, rollback e restauração

Monitorar grant perto do vencimento, certificado perto do limite configurado,
erros TLS, circuito de serviço aberto, consultas perto do limite, trocas
`send_started` sem resposta, `raw_unparsed`, decisão `unknown` e artefatos ausentes.
Alertar o operador Fiscal; não converter automaticamente esses casos em rejeição.

Para parar o rollout, não conceder novos grants e usar
`phase43:activation -- --action deactivate --file <json>` se a capability tiver
sido ativada. Preservar trocas e números existentes. Drenar comandos preparados
por observação e consulta, mantendo incertos para reconciliação; não emitir outra
NF-e com a mesma origem para tentar limpar a fila.

Restaurar banco e objetos criptografados juntos em ambiente isolado. Executar
`phase43:restore-verify -- --tenant <uuid> --document <uuid>` para cada documento;
o comando relê XML assinado, SOAP, respostas e protocolos pelos digests do ledger.
Conferir tenant e capability, processar respostas `raw_unparsed`, demonstrar que
trocas `send_started` não reenviam e que o gate Sales segue bloqueado. Registrar
resultado, horário, operador e digests no documento de evidências.

Somente após autorização, consulta, rejeição, indisponibilidade, cancelamento e
restauração terem evidências reais revisadas, registrar a evidência vinculada pelo
`phase43:activation -- --action evidence --file <json>` e ativar com
`--action activate`. O banco exige os IDs relacionados de autorização, consulta
autorizada e cancelamento. A publicação em produção permanece desabilitada.
