import { reporterLineSchema, revealedLandmines, type GeneratedScenario, type ReporterLine } from "@hot-seat/shared";
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

/** A scenario the brain can run: a generated one, or the legacy café fixture. */
export type BrainScenario = GeneratedScenario | DemoScenario;

export function isGenerated(scenario: BrainScenario): scenario is GeneratedScenario {
  return "journalists" in scenario;
}

/** The single journalist for this brief. Press conferences use the first. */
export function primaryJournalist(scenario: GeneratedScenario) {
  const journalist = scenario.journalists[0];
  if (!journalist) throw new Error("Scenario has no journalists");
  return journalist;
}

interface Persona {
  journalistId: string;
  name: string;
  outlet: string;
  temperament: string;
  agenda: string;
  publicFacts: string[];
  openingQuestion: string | null;
}

function persona(scenario: BrainScenario): Persona {
  if (isGenerated(scenario)) {
    const j = primaryJournalist(scenario);
    return {
      journalistId: j.id,
      name: j.name,
      outlet: j.outlet,
      temperament: j.temperament,
      agenda: j.agenda,
      publicFacts: scenario.public_facts,
      openingQuestion: j.opening_question,
    };
  }
  return {
    journalistId: "J1",
    name: scenario.reporter.name,
    outlet: scenario.reporter.outlet,
    temperament: scenario.reporter.temperament,
    agenda: scenario.reporter.agenda,
    publicFacts: scenario.publicFacts,
    openingQuestion: null,
  };
}

function landminesText(scenario: BrainScenario, journalistId: string, elapsedSeconds: number): string {
  if (!isGenerated(scenario)) return "None yet.";
  const known = revealedLandmines(scenario, journalistId, elapsedSeconds);
  return known.length > 0 ? known.map((m) => m.fact).join("; ") : "None yet.";
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

  /** Generated scenarios carry their opening question: no extra LLM call. */
  async openingQuestion(scenario: BrainScenario): Promise<ReporterLine> {
    const p = persona(scenario);
    if (p.openingQuestion) {
      return { move: "new_angle", flags: [], say: p.openingQuestion, quote_used: null };
    }
    const prompt = fillTemplate(this.prompts.openingQuestion, {
      ...this.vars(scenario, 0),
      spoken_style: this.prompts.spokenStyle,
    });
    return this.ask(prompt);
  }

  async nextTurn(
    scenario: BrainScenario,
    history: ConversationTurn[],
    lastAnswer: string,
    elapsedSeconds = 0,
    signal?: AbortSignal,
  ): Promise<ReporterLine> {
    const p = persona(scenario);
    const tail = history
      .slice(-8)
      .map((t) => `${t.role === "user" ? "Owner" : p.name}: ${t.text}`)
      .join("\n");
    const prompt = fillTemplate(this.prompts.journalistTurn, {
      ...this.vars(scenario, elapsedSeconds),
      transcript_tail: tail || "(nothing yet)",
      last_answer: lastAnswer,
      spoken_style: this.prompts.spokenStyle,
    });
    return this.ask(prompt, signal);
  }

  private vars(scenario: BrainScenario, elapsedSeconds: number): Record<string, string> {
    const p = persona(scenario);
    return {
      name: p.name,
      outlet: p.outlet,
      temperament: p.temperament,
      agenda: p.agenda,
      public_facts: p.publicFacts.join("; "),
      landmines_known_to_you: landminesText(scenario, p.journalistId, elapsedSeconds),
    };
  }

  private async ask(prompt: string, signal?: AbortSignal): Promise<ReporterLine> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw abortError();
      const retryNote =
        attempt === 0
          ? ""
          : "\n\nYour previous reply was not valid JSON in the required shape. Return ONLY the JSON object, nothing else.";
      let result;
      try {
        result = await this.llm.chat({
          model: this.model,
          messages: [{ role: "user", content: prompt + retryNote }],
          maxTokens: 2000,
          reasoningEffort: "minimal",
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw abortError();
        throw err;
      }
      if (signal?.aborted) throw abortError();
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

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Parse tolerantly (code fences, surrounding prose) then validate strictly with zod. */
export function parseReporterLine(text: string): ReporterLine {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in LLM reply");
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  return reporterLineSchema.parse(raw);
}
