import type { Llm } from "./providers/llm.js";
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
}

export interface InterruptDecider {
  decide(input: InterruptDecisionInput): Promise<InterruptDecision>;
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

  async decide(input: InterruptDecisionInput): Promise<InterruptDecision> {
    const prompt = fillTemplate(this.template, {
      name: input.name,
      outlet: input.outlet,
      question: input.question,
      seconds: String(Math.round(input.seconds)),
      partial: input.partial,
      facts: input.facts,
    });
    const result = await this.llm.chat({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 200,
      reasoningEffort: "minimal",
    });
    return parseInterruptDecision(result.text);
  }
}
