import { reporterLineSchema, type ReporterLine } from "@hot-seat/shared";
import type { Llm } from "./providers/llm.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import type { DemoScenario } from "./scenarios/cafe.js";

export interface JournalistPrompts {
  spokenStyle: string;
  journalistTurn: string;
  openingQuestion: string;
}

export async function loadJournalistPrompts(): Promise<JournalistPrompts> {
  const [spokenStyle, journalistTurn, openingQuestion] = await Promise.all([
    loadPrompt("spoken-style.md"),
    loadPrompt("journalist-turn.md"),
    loadPrompt("opening-question.md"),
  ]);
  return { spokenStyle: spokenStyle.trim(), journalistTurn, openingQuestion };
}

export interface ConversationTurn {
  role: "user" | "reporter";
  text: string;
}

/** One reporter brain: Muse Spark chat with zod-validated JSON, one retry. */
export class JournalistBrain {
  private readonly llm: Llm;
  private readonly prompts: JournalistPrompts;
  private readonly model: string;

  constructor(llm: Llm, prompts: JournalistPrompts, model = "muse-spark-1.3") {
    this.llm = llm;
    this.prompts = prompts;
    this.model = model;
  }

  async openingQuestion(scenario: DemoScenario): Promise<ReporterLine> {
    const prompt = fillTemplate(this.prompts.openingQuestion, {
      ...personaVars(scenario),
      spoken_style: this.prompts.spokenStyle,
    });
    return this.ask(prompt);
  }

  async nextTurn(scenario: DemoScenario, history: ConversationTurn[], lastAnswer: string): Promise<ReporterLine> {
    const tail = history
      .slice(-8)
      .map((t) => `${t.role === "user" ? "Owner" : scenario.reporter.name}: ${t.text}`)
      .join("\n");
    const prompt = fillTemplate(this.prompts.journalistTurn, {
      ...personaVars(scenario),
      transcript_tail: tail || "(nothing yet)",
      last_answer: lastAnswer,
      spoken_style: this.prompts.spokenStyle,
    });
    return this.ask(prompt);
  }

  private async ask(prompt: string): Promise<ReporterLine> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const retryNote =
        attempt === 0
          ? ""
          : "\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object, nothing else.";
      const result = await this.llm.chat({
        model: this.model,
        messages: [{ role: "user", content: prompt + retryNote }],
        maxTokens: 2000,
        reasoningEffort: "minimal",
      });
      try {
        return parseReporterLine(result.text);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `Journalist LLM returned invalid JSON after one retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

function personaVars(scenario: DemoScenario): Record<string, string> {
  return {
    name: scenario.reporter.name,
    outlet: scenario.reporter.outlet,
    temperament: scenario.reporter.temperament,
    agenda: scenario.reporter.agenda,
    public_facts: scenario.publicFacts.join("; "),
  };
}

/** Parse tolerantly (code fences, surrounding prose) then validate strictly with zod. */
export function parseReporterLine(text: string): ReporterLine {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in LLM reply");
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  return reporterLineSchema.parse(raw);
}
