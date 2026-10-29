/**
 * Minimum max-token budget for reasoning models. Reasoning tokens count
 * against max_tokens, so a small budget is spent before any content is
 * written and the reply comes back empty with finish_reason=length.
 */
export const MIN_REASONING_MAX_TOKENS = 1500;

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Diagnostic suffix for an empty-content error, e.g. "empty content, finish_reason=length, reasoning_tokens=200". */
export function describeEmptyContent(finishReason: string | null | undefined, usage?: LlmUsage): string {
  const parts = [`finish_reason=${finishReason ?? "unknown"}`];
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
  if (reasoning !== undefined) parts.push(`reasoning_tokens=${reasoning}`);
  if (usage?.completion_tokens !== undefined) parts.push(`completion_tokens=${usage.completion_tokens}`);
  if (usage?.prompt_tokens !== undefined) parts.push(`prompt_tokens=${usage.prompt_tokens}`);
  if (usage?.total_tokens !== undefined) parts.push(`total_tokens=${usage.total_tokens}`);
  return `empty content, ${parts.join(", ")}`;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatInput {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  /** Per-call model-call timeout. Defaults to the provider's configured timeout. */
  timeoutMs?: number;
}

export interface LlmChatResult {
  text: string;
  model: string;
  finishReason: string | null;
}

export interface LlmStructuredInput<T> {
  /** Instruction describing the JSON shape to return. */
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  /** Per-call model-call timeout. Defaults to the provider's configured timeout. */
  timeoutMs?: number;
  /** Validate and parse the raw JSON value. Throw to reject it. */
  parse: (raw: unknown) => T;
}

/** Chat plus structured JSON. Swap adapters behind this port. */
export interface Llm {
  chat(input: LlmChatInput): Promise<LlmChatResult>;
  generateStructured<T>(input: LlmStructuredInput<T>): Promise<T>;
}
