import { MIN_REASONING_MAX_TOKENS, type Llm } from "../../src/providers/llm.js";

export interface OwnerSegment {
  text: string;
  pause_after_ms: number;
}

export interface ConversationLine {
  role: string;
  text: string;
}

export interface OwnerAnswerInput {
  /** Persona Markdown (one profile file). */
  profile: string;
  briefing: readonly string[];
  conversation: readonly ConversationLine[];
  reporterLine: string;
}

/** Parse and validate the owner agent's JSON. Pauses are clamped to 0..2500 ms. */
export function parseOwnerSegments(text: string): OwnerSegment[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("owner agent returned no JSON object");
  const raw = JSON.parse(text.slice(start, end + 1)) as { segments?: unknown };
  if (!Array.isArray(raw.segments)) throw new Error("owner agent JSON has no segments array");
  const segments: OwnerSegment[] = [];
  for (const item of raw.segments) {
    if (typeof item !== "object" || item === null) continue;
    const seg = item as { text?: unknown; pause_after_ms?: unknown };
    if (typeof seg.text !== "string" || !seg.text.trim()) continue;
    const pause = typeof seg.pause_after_ms === "number" && Number.isFinite(seg.pause_after_ms) ? seg.pause_after_ms : 0;
    segments.push({ text: seg.text.trim(), pause_after_ms: Math.min(2500, Math.max(0, Math.round(pause))) });
  }
  if (segments.length === 0) throw new Error("owner agent returned no usable segments");
  return segments;
}

export function estimateTtsChars(segments: readonly OwnerSegment[]): number {
  return segments.reduce((sum, s) => sum + s.text.length, 0);
}

export function buildOwnerPrompt(input: OwnerAnswerInput): string {
  const convo = input.conversation.map((l) => `${l.role}: ${l.text}`).join("\n") || "(nothing yet)";
  return [
    "You are playing a small business owner in a live spoken crisis interview rehearsal.",
    "Speak exactly as this persona would, out loud, in English. Never break character or mention being an AI.",
    "",
    "Persona:",
    input.profile.trim(),
    "",
    "What you (the owner) were briefed before the interview:",
    input.briefing.map((b) => `- ${b}`).join("\n") || "- (no briefing)",
    "",
    "Conversation so far (most recent last):",
    convo,
    "",
    `The reporter just said: "${input.reporterLine}"`,
    "",
    "Write your next spoken answer. Split it into segments at natural breath points.",
    "After each segment give pause_after_ms (0 to 2500): how long you pause before continuing.",
    "Use the pauses your persona calls for. Keep to the persona's length habits.",
    'Return ONLY JSON: { "segments": [{ "text": "...", "pause_after_ms": 0 }] }',
  ].join("\n");
}

/** Muse Spark, minimal reasoning, one call per owner answer. */
export class OwnerAgent {
  constructor(
    private readonly llm: Llm,
    private readonly model = "muse-spark-1.3",
  ) {}

  async nextAnswer(input: OwnerAnswerInput): Promise<OwnerSegment[]> {
    const result = await this.llm.chat({
      model: this.model,
      messages: [{ role: "user", content: buildOwnerPrompt(input) }],
      maxTokens: MIN_REASONING_MAX_TOKENS,
      reasoningEffort: "minimal",
    });
    return parseOwnerSegments(result.text);
  }
}
