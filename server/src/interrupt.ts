import { MIN_REASONING_MAX_TOKENS, type Llm } from "./providers/llm.js";
import { fillTemplate } from "./prompts.js";

export interface InterruptDecision {
  interrupt: boolean;
  reason: string;
  say: string;
}

export interface InterruptDecisionInput {
  name: string;
  outlet: string;
  question: string;
  seconds: number;
  partial: string;
  facts: string;
  /** Brief 18b: the active beat's goal, so the cut-in presses on the live topic. */
  beatGoal?: string;
  /** Brief 18b: every question already asked: the cut-in must not re-ask one. */
  asked?: readonly string[];
}

/**
 * A decision is stale only when the answer it was made on is no longer the
 * live answer: the turn closed (or a new answer started), or the current
 * partial no longer starts with the snapshot text. A partial that merely
 * grew while the decision was in flight still starts with the snapshot,
 * so a rambling answer that keeps going is acted on.
 */
export function isInterruptDecisionStale(snapshot: string, currentPartial: string, answerActive: boolean): boolean {
  if (!answerActive) return true;
  return !currentPartial.startsWith(snapshot);
}

export interface InterruptDecider {
  decide(input: InterruptDecisionInput, signal?: AbortSignal): Promise<InterruptDecision>;
}

export function parseInterruptDecision(text: string): InterruptDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in LLM reply");
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const interrupt = raw.interrupt === true;
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  const say = typeof raw.say === "string" ? raw.say : "";
  if (interrupt && !say.trim()) return { interrupt: false, reason, say: "" };
  return { interrupt, reason, say: interrupt ? say : "" };
}

/** One TURN_LLM call per decision, minimal reasoning, JSON only. */
export class LlmInterruptDecider implements InterruptDecider {
  constructor(
    private readonly llm: Llm,
    private readonly template: string,
    private readonly model: string,
  ) {}

  async decide(input: InterruptDecisionInput, signal?: AbortSignal): Promise<InterruptDecision> {
    const prompt = fillTemplate(this.template, {
      name: input.name,
      outlet: input.outlet,
      question: input.question,
      seconds: String(Math.round(input.seconds)),
      partial: input.partial,
      facts: input.facts,
      beat_goal: input.beatGoal?.trim() ? input.beatGoal : "(none)",
      asked_lines: input.asked && input.asked.length > 0 ? input.asked.map((a) => `- ${a}`).join("\n") : "(none yet)",
    });
    const result = await this.llm.chat({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: MIN_REASONING_MAX_TOKENS,
      reasoningEffort: "minimal",
      ...(signal ? { signal } : {}),
    });
    return parseInterruptDecision(result.text);
  }
}
