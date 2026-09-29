import {
  type GeneratedBlock,
  type GenerationMessage,
  type GenerationRequest,
  type GenerationResult,
  Generator,
} from '@/application/generation'

export interface AnthropicOptions {
  readonly apiKey: string | undefined
  readonly model: string
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly fetch?: typeof fetch
}

/** A provider's refusal, by status only: its body may quote what was sent. */
export class GenerationError extends Error {
  constructor(readonly status: number) {
    super(`The model provider answered ${status}`)
    this.name = 'GenerationError'
  }
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string }

function wire(message: GenerationMessage) {
  if (message.role === 'assistant') return { role: 'assistant', content: message.content }
  return {
    role: 'user',
    content: message.content.map((block) =>
      block.type === 'text'
        ? block
        : {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            ...(block.isError ? { is_error: true } : {}),
          },
    ),
  }
}

/**
 * The Anthropic Messages API with tool use (ADR 0069). The model is configuration; without
 * a key the generator is unavailable and is never called. Only the question, the
 * conversation so far and what the person's own tools answered are sent.
 */
export class AnthropicGenerator extends Generator {
  readonly provider = 'Anthropic'
  readonly model: string
  readonly available: boolean
  readonly #fetch: typeof fetch

  constructor(private readonly options: AnthropicOptions) {
    super()
    this.model = options.model
    this.available = Boolean(options.apiKey)
    this.#fetch = options.fetch ?? fetch
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (!this.options.apiKey) throw new Error('No model provider key is configured')
    const response = await this.#fetch(new URL('/v1/messages', this.options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map(wire),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        tool_choice:
          request.force === 'any' ? { type: 'any' } : { type: 'tool', name: request.force.tool },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    })
    if (!response.ok) throw new GenerationError(response.status)
    const body = (await response.json()) as {
      content?: AnthropicBlock[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const content = (body.content ?? []).flatMap((block): GeneratedBlock[] => {
      if (block.type === 'text' && 'text' in block) return [{ type: 'text', text: block.text }]
      if (block.type === 'tool_use' && 'id' in block)
        return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }]
      return []
    })
    return {
      content,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
    }
  }
}
