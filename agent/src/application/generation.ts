/**
 * The generation port (ADR 0069): a model that reads a conversation and either calls tools
 * or answers. Horizon's words, not a provider's, so an adapter can be swapped.
 */
export type GeneratedBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use'
      readonly id: string
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
    }

export type UserBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_result'
      readonly toolUseId: string
      readonly content: string
      readonly isError?: boolean
    }

export type GenerationMessage =
  | { readonly role: 'user'; readonly content: readonly UserBlock[] }
  | { readonly role: 'assistant'; readonly content: readonly GeneratedBlock[] }

export interface GenerationTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface GenerationRequest {
  readonly system: string
  readonly messages: readonly GenerationMessage[]
  readonly tools: readonly GenerationTool[]
  /** `any`: some tool must be called; `{ tool }`: that one. */
  readonly force: 'any' | { readonly tool: string }
  readonly maxTokens: number
}

export interface GenerationUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface GenerationResult {
  readonly content: readonly GeneratedBlock[]
  readonly usage: GenerationUsage
}

export abstract class Generator {
  /** Who receives what is sent, as the notice names it. */
  abstract readonly provider: string
  abstract readonly model: string
  /** False when it cannot be called at all (no key): then nothing is ever sent. */
  abstract readonly available: boolean
  abstract generate(request: GenerationRequest): Promise<GenerationResult>
}

/** The tool every answer ends with: statements, each naming the sources it rests on. */
export const ANSWER_TOOL: GenerationTool = {
  name: 'answer',
  description:
    'Give the answer. Each statement names the ids of the sources (S1, S2…) it rests on. A statement with no source is shown as not found; never state what no source says.',
  inputSchema: {
    type: 'object',
    properties: {
      statements: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 2000 },
            sources: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          },
          required: ['text', 'sources'],
          additionalProperties: false,
        },
      },
    },
    required: ['statements'],
    additionalProperties: false,
  },
}
