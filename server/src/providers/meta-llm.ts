import { describeEmptyContent, type Llm, type LlmChatInput, type LlmChatResult, type LlmStructuredInput, type LlmUsage } from "./llm.js";
import { DEBRIEF_TIMEOUT_MS, TURN_LLM_TIMEOUT_MS, timeoutSignal } from "./timeout.js";

export interface MetaLlmOptions {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  structuredModel?: string;
  fetchFn?: typeof fetch;
  chatTimeoutMs?: number;
  structuredTimeoutMs?: number;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
  usage?: LlmUsage;
}

interface ResponsesResponse {
  output_text?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
  output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
}

/**
 * Meta Model API adapter (https://api.meta.ai/v1, OpenAI compatible).
 * Chat uses chat completions (Muse Spark). Structured JSON uses the Responses API (Muse Wonder).
 */
export class MetaLlm implements Llm {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly structuredModel: string;
  private readonly fetchFn: typeof fetch;
  private readonly chatTimeoutMs: number;
  private readonly structuredTimeoutMs: number;

  constructor(options: MetaLlmOptions) {
    if (!options.apiKey) throw new Error("MetaLlm requires an apiKey (MODEL_API_KEY)");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.meta.ai/v1").replace(/\/$/, "");
    this.chatModel = options.chatModel ?? "muse-spark-1.3";
    this.structuredModel = options.structuredModel ?? "muse-wonder-1.0";
    this.fetchFn = options.fetchFn ?? fetch;
    this.chatTimeoutMs = options.chatTimeoutMs ?? TURN_LLM_TIMEOUT_MS;
    this.structuredTimeoutMs = options.structuredTimeoutMs ?? DEBRIEF_TIMEOUT_MS;
  }

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const model = input.model ?? this.chatModel;
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      signal: timeoutSignal(input.timeoutMs ?? this.chatTimeoutMs, input.signal),
      body: JSON.stringify({
        model,
        messages: input.messages,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoning_effort: input.reasoningEffort } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Meta Model API chat failed: ${res.status} ${await safeText(res)}`);
    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || text.trim() === "")
      throw new Error(`Meta Model API chat returned no message content: ${describeEmptyContent(choice?.finish_reason, data.usage)}`);
    return { text, model: data.model ?? model, finishReason: choice?.finish_reason ?? null };
  }

  async generateStructured<T>(input: LlmStructuredInput<T>): Promise<T> {
    const model = input.model ?? this.structuredModel;
    const res = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      signal: timeoutSignal(input.timeoutMs ?? this.structuredTimeoutMs, input.signal),
      body: JSON.stringify({
        model,
        ...(input.system ? { instructions: input.system } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoning: { effort: input.reasoningEffort } } : {}),
        ...(input.maxTokens !== undefined ? { max_output_tokens: input.maxTokens } : {}),
        input: `${input.prompt}\n\nRespond with JSON only, no prose.`,
        text: { format: { type: "json_object" } },
      }),
    });
    if (!res.ok) throw new Error(`Meta Model API responses failed: ${res.status} ${await safeText(res)}`);
    const data = (await res.json()) as ResponsesResponse;
    const rawText = data.output_text ?? data.output?.flatMap((o) => o.content ?? []).find((c) => typeof c.text === "string")?.text;
    if (!rawText)
      throw new Error(
        `Meta Model API responses returned no output text: ${describeEmptyContent(data.incomplete_details?.reason ?? data.status, {
          prompt_tokens: data.usage?.input_tokens,
          completion_tokens: data.usage?.output_tokens,
          total_tokens: data.usage?.total_tokens,
          completion_tokens_details: { reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens },
        })}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Meta Model API returned invalid JSON: ${rawText.slice(0, 200)}`);
    }
    return input.parse(parsed);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
