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
  reasoningEffort?: string;
  signal?: AbortSignal;
  /** Validate and parse the raw JSON value. Throw to reject it. */
  parse: (raw: unknown) => T;
}

/** Chat plus structured JSON. Swap adapters behind this port. */
export interface Llm {
  chat(input: LlmChatInput): Promise<LlmChatResult>;
  generateStructured<T>(input: LlmStructuredInput<T>): Promise<T>;
}
