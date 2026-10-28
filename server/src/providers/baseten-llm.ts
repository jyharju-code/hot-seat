import { describeEmptyContent, type Llm, type LlmChatInput, type LlmChatResult, type LlmStructuredInput, type LlmUsage } from "./llm.js";

export interface BasetenLlmOptions {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  fetchFn?: typeof fetch;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
  usage?: LlmUsage;
}

export const BASETEN_DEFAULT_MODEL = "meta-models/muse-spark-open-1026";

/** Baseten adapter (OpenAI compatible). Header is `Api-Key`, not Bearer. */
export class BasetenLlm implements Llm {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BasetenLlmOptions) {
    if (!options.apiKey) throw new Error("BasetenLlm requires an apiKey (BASETEN_API_KEY)");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://inference.baseten.co/v1").replace(/\/$/, "");
    this.chatModel = options.chatModel ?? BASETEN_DEFAULT_MODEL;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const model = input.model ?? this.chatModel;
    const attempt = async (withReasoning: boolean): Promise<Response> =>
      this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Api-Key ${this.apiKey}` },
        ...(input.signal ? { signal: input.signal } : {}),
        body: JSON.stringify({
          model,
          messages: input.messages,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(withReasoning && input.reasoningEffort !== undefined ? { reasoning_effort: input.reasoningEffort } : {}),
        }),
      });
    let res = await attempt(true);
    if (!res.ok && input.reasoningEffort !== undefined) {
      const body = await safeText(res);
      if (/reasoning_effort/i.test(body)) {
        res = await attempt(false);
        if (!res.ok) throw new Error(`Baseten chat failed: ${res.status} ${await safeText(res)}`);
      } else {
        throw new Error(`Baseten chat failed: ${res.status} ${body}`);
      }
    } else if (!res.ok) {
      throw new Error(`Baseten chat failed: ${res.status} ${await safeText(res)}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || text.trim() === "")
      throw new Error(`Baseten chat returned no message content: ${describeEmptyContent(choice?.finish_reason, data.usage)}`);
    return { text, model: data.model ?? model, finishReason: choice?.finish_reason ?? null };
  }

  async generateStructured<T>(input: LlmStructuredInput<T>): Promise<T> {
    const result = await this.chat({
      model: input.model ?? this.chatModel,
      messages: [
        ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
        { role: "user", content: `${input.prompt}\n\nRespond with JSON only, no prose.` },
      ],
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    let parsed: unknown;
    try {
      const start = result.text.indexOf("{");
      const end = result.text.lastIndexOf("}");
      parsed = JSON.parse(start >= 0 && end > start ? result.text.slice(start, end + 1) : result.text);
    } catch {
      throw new Error(`Baseten returned invalid JSON: ${result.text.slice(0, 200)}`);
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
