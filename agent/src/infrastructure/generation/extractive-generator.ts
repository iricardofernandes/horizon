import {
  ANSWER_TOOL,
  type GeneratedBlock,
  type GenerationMessage,
  type GenerationRequest,
  type GenerationResult,
  Generator,
} from '@/application/generation'

/** Words that name a module's records, and the list tool that reads them. */
const KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/\b(clientes?|customers?|parceiros?|parties|fornecedor(es)?|suppliers?)\b/i, 'list_parties'],
  [/\b(contas? a pagar|payables?)\b/i, 'list_payables'],
  [/\b(contas? a receber|receivables?)\b/i, 'list_receivables'],
  [/\b(oportunidades?|opportunit(y|ies))\b/i, 'list_opportunities'],
  [/\b(pedidos? de compra|purchase orders?)\b/i, 'list_purchase_orders'],
  [/\b(itens|items?|produtos?|products?)\b/i, 'list_items'],
]

const DATA =
  /<data source="(S\d+)" kind="(document|record)"(?: tool="([^"]+)")?>([\s\S]*?)<\/data>/g

/** Portuguese or English, as the question reads: the extractive answer speaks its language. */
const PORTUGUESE =
  /[ãõçáéíóúâêô]|\b(que|qual|quais|como|onde|quem|quanto|quantos|existem|diz|são|está|não)\b/i

type Words = { records: (tool: string, rows: number | null) => string; nothing: string }
const WORDS: Readonly<Record<'pt' | 'en', Words>> = {
  pt: {
    records: (tool, rows) =>
      rows === null ? `${tool}: 1 registro` : `${tool}: ${rows} registro(s)`,
    nothing: 'Nada do que posso ler responde a isso.',
  },
  en: {
    records: (tool, rows) => (rows === null ? `${tool}: 1 record` : `${tool}: ${rows} record(s)`),
    nothing: 'Nothing I can read answers this.',
  },
}

export const languageOf = (question: string): 'pt' | 'en' =>
  PORTUGUESE.test(question) ? 'pt' : 'en'

/** Characters over four: near enough to what a provider would count, and deterministic. */
const tokensOf = (text: string) => Math.ceil(text.length / 4)

function lastQuestion(messages: readonly GenerationMessage[]): { text: string; index: number } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const text =
      message?.role === 'user' ? message.content.find((block) => block.type === 'text') : undefined
    if (text?.type === 'text') return { text: text.text, index }
  }
  return { text: '', index: -1 }
}

function rowsIn(json: string): number | null {
  try {
    const { result } = JSON.parse(json) as { result?: unknown }
    if (Array.isArray(result)) return result.length
    const data = (result as { data?: unknown } | null)?.data
    return Array.isArray(data) ? data.length : null
  } catch {
    return null
  }
}

/** One statement per quoted source in a tool result: a document quoted, a record counted. */
function statementsIn(content: string, words: Words): { text: string; sources: string[] }[] {
  return [...content.matchAll(DATA)].flatMap(([, id, kind, tool, body]) => {
    if (!id || !body) return []
    if (kind === 'document') {
      const { excerpt } = JSON.parse(body) as { excerpt?: string }
      return [{ text: `“${(excerpt ?? '').slice(0, 300)}”`, sources: [id] }]
    }
    return [{ text: words.records(tool ?? '', rowsIn(body)), sources: [id] }]
  })
}

/**
 * The deterministic generator of CI and of a stack with no provider key (ADR 0069). It
 * searches the documents with the question and reads the list its words name, then answers
 * one statement per source, quoting it. It never leaves the process and follows nothing
 * written inside data.
 */
export class ExtractiveGenerator extends Generator {
  readonly provider = 'Horizon (extractive, inside the stack)'
  readonly model = 'extractive-v1'
  readonly available = true

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const question = lastQuestion(request.messages)
    const hasResults = request.messages
      .slice(question.index + 1)
      .some((message) => message.role === 'user')
    const planned = !hasResults && request.force === 'any' ? this.plan(question.text, request) : []
    const content: GeneratedBlock[] = planned.length
      ? planned
      : [this.answer(request.messages.slice(question.index + 1), WORDS[languageOf(question.text)])]
    return {
      content,
      usage: {
        inputTokens: tokensOf(request.system + JSON.stringify(request.messages)),
        outputTokens: tokensOf(JSON.stringify(content)),
      },
    }
  }

  private plan(question: string, request: GenerationRequest): GeneratedBlock[] {
    const offered = new Set(request.tools.map((tool) => tool.name))
    const uses: GeneratedBlock[] = []
    if (offered.has('search_documents') && question.trim().length >= 2)
      uses.push({
        type: 'tool_use',
        id: 'extractive-1',
        name: 'search_documents',
        input: { q: question.trim().slice(0, 200) },
      })
    const named = KEYWORDS.find(([words, tool]) => words.test(question) && offered.has(tool))
    if (named)
      uses.push({
        type: 'tool_use',
        id: `extractive-${uses.length + 1}`,
        name: named[1],
        input: {},
      })
    return uses
  }

  private answer(since: readonly GenerationMessage[], words: Words): GeneratedBlock {
    const statements = since.flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((block) =>
            block.type === 'tool_result' && !block.isError
              ? statementsIn(block.content, words)
              : [],
          )
        : [],
    )
    return {
      type: 'tool_use',
      id: 'extractive-answer',
      name: ANSWER_TOOL.name,
      input: {
        statements: statements.length
          ? statements.slice(0, 20)
          : [{ text: words.nothing, sources: [] }],
      },
    }
  }
}
