import { isProfileScenario, reporterLineSchema, revealedLandmines, sessionDurationSeconds, PROFILE_WRAP_UP_SECONDS, type Escalation, type GeneratedScenario, type ReporterLine } from "@hot-seat/shared";
import type { Llm } from "./providers/llm.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import { resolveEffectiveBeatId } from "./session/line-match.js";
import type { DemoScenario } from "./scenarios/cafe.js";

export interface JournalistPrompts {
  spokenStyle: string;
  journalistTurn: string;
  openingQuestion: string;
  profileTurn?: string;
  interviewPlan?: string;
}

export async function loadJournalistPrompts(): Promise<JournalistPrompts> {
  const [spokenStyle, journalistTurn, openingQuestion, profileTurn, interviewPlan] = await Promise.all([
    loadPrompt("spoken-style.md"),
    loadPrompt("journalist-turn.md"),
    loadPrompt("opening-question.md"),
    loadPrompt("profile-journalist-turn.md"),
    loadPrompt("interview-plan.md").catch(() => ""),
  ]);
  return { spokenStyle: spokenStyle.trim(), journalistTurn, openingQuestion, profileTurn, interviewPlan };
}

/** Structured interview context computed in code before a turn (Brief 17). */
export interface InterviewTurnContext {
  planLines: string;
  activeBeatLine: string;
  directive: string;
  nextBeatGoal: string;
  established: string[];
  commitments: string[];
  openThreads: string[];
  asked: string[];
  closedBeatIds: string[];
  callbackBeatId?: string | null;
  fallbackLine: ReporterLine;
  /** Brief 18b: beat each asked line served, parallel to `asked`, interrupts included. */
  askedBeats?: Array<string | undefined>;
  /** Brief 18b: beats closed OR already at max_questions: serving them again is a repeat. */
  spentBeatIds?: string[];
  /** Brief 18b: distinctive landmine facts, for repairing a wrong model beat label. */
  landmineFacts?: Array<{ beatId: string; fact: string }>;
}

export function isProfileBrainScenario(scenario: BrainScenario): boolean {
  return isGenerated(scenario) && isProfileScenario(scenario);
}

export interface ConversationTurn {
  role: "user" | "reporter" | "news";
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

function landminesText(
  scenario: BrainScenario,
  journalistId: string,
  elapsedSeconds: number,
  learnedEscalations: readonly Escalation[] = [],
): string {
  if (!isGenerated(scenario)) return "None yet.";
  if (isProfileScenario(scenario)) return "None yet.";
  const known = revealedLandmines(scenario, journalistId, elapsedSeconds).map((m) => m.fact);
  const fromEscalations = learnedEscalations
    .filter((e) => e.gives_journalist === journalistId)
    .map((e) => e.new_fact);
  const all = [...known, ...fromEscalations];
  return all.length > 0 ? all.join("; ") : "None yet.";
}

/** One reporter brain: Muse Spark chat with zod-validated JSON, one retry. */
export class JournalistBrain {
  private readonly llm: Llm;
  private readonly prompts: JournalistPrompts;
  private readonly model: string;
  private readonly log: (line: string) => void;

  constructor(llm: Llm, prompts: JournalistPrompts, model = "muse-spark-1.3", log?: (line: string) => void) {
    this.llm = llm;
    this.prompts = prompts;
    this.model = model;
    this.log = log ?? (() => undefined);
  }

  /** Winner of the underlying provider race, when the LLM tracks one. */
  get lastRaceWinner(): "meta" | "baseten" | null {
    const llm = this.llm as Llm & { lastWinner?: "meta" | "baseten" | null };
    return llm.lastWinner ?? null;
  }

  /** Generated scenarios carry their opening question: no extra LLM call. */
  async openingQuestion(scenario: BrainScenario, signal?: AbortSignal): Promise<ReporterLine> {
    const p = persona(scenario);
    if (p.openingQuestion) {
      return { move: "new_angle", flags: [], say: p.openingQuestion, quote_used: null };
    }
    const prompt = fillTemplate(this.prompts.openingQuestion, {
      ...this.vars(scenario, 0),
      spoken_style: this.prompts.spokenStyle,
    });
    return this.ask(prompt, signal);
  }

  async nextTurn(
    scenario: BrainScenario,
    history: ConversationTurn[],
    lastAnswer: string,
    elapsedSeconds = 0,
    signal?: AbortSignal,
    learnedEscalations: readonly Escalation[] = [],
    interview?: InterviewTurnContext,
  ): Promise<ReporterLine> {
    const p = persona(scenario);
    const full = history
      .map((t) => `${t.role === "user" ? "Owner" : t.role === "news" ? "News" : p.name}: ${t.text}`)
      .join("\n");
    const recent = history.filter((t) => t.role === "reporter").slice(-3).map((t) => t.text);
    const profile = isProfileBrainScenario(scenario);
    const template = profile ? (this.prompts.profileTurn ?? this.prompts.journalistTurn) : this.prompts.journalistTurn;
    const prompt = fillTemplate(template, {
      ...this.vars(scenario, elapsedSeconds, learnedEscalations),
      elapsed_seconds: String(Math.round(elapsedSeconds)),
      duration_seconds: String(profile && isGenerated(scenario) ? sessionDurationSeconds(scenario) : 0),
      transcript_tail: full || "(nothing yet)",
      full_transcript: full || "(nothing yet)",
      your_recent_lines: recent.length > 0 ? recent.join("\n") : "(none yet)",
      interview_plan: interview?.planLines ?? "(no plan yet)",
      active_beat: interview?.activeBeatLine ?? "(none)",
      directive: interview?.directive ?? "PUSH",
      next_beat_goal: interview?.nextBeatGoal ?? "",
      established: interview && interview.established.length > 0 ? interview.established.join("; ") : "(nothing established yet)",
      commitments: interview && interview.commitments.length > 0 ? interview.commitments.join("; ") : "(none)",
      open_threads: interview && interview.openThreads.length > 0 ? interview.openThreads.join("; ") : "(none)",
      asked_lines: interview && interview.asked.length > 0 ? interview.asked.map((a) => `- ${a}`).join("\n") : "(none yet)",
      last_answer: lastAnswer,
      spoken_style: this.prompts.spokenStyle,
    });
    if (!interview) return this.ask(prompt, signal);
    // Repeat guard: closed beat, exact text already asked, or a profile
    // goodbye before wrap-up time. Retry once, then deterministic fallback.
    const norm = (t: string) => t.replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const duration = profile && isGenerated(scenario) ? sessionDurationSeconds(scenario) : 0;
    const goodbyeLocked = profile && duration > 0 && elapsedSeconds < duration - PROFILE_WRAP_UP_SECONDS;
    const isGoodbye = (t: string) => /\b(thank you|thanks|goodbye|farewell)\b/.test(norm(t)) || /\bbye\b/.test(norm(t)) || norm(t).includes("nearly out of time");
    // Brief 18b: the line counts where its text belongs, not only where the
    // model labelled it. A screening-form line labelled `responsibility`
    // still serves its landmine beat, and serving a spent beat is a repeat.
    const spent = new Set([...interview.closedBeatIds, ...(interview.spentBeatIds ?? [])]);
    const effectiveBeat = (line: ReporterLine): string | undefined =>
      resolveEffectiveBeatId(line.say ?? "", line.beat_id ?? undefined, {
        asked: interview.asked,
        askedBeats: interview.askedBeats ?? [],
        landmineFacts: interview.landmineFacts ?? [],
      });
    const isRepeat = (line: ReporterLine): boolean => {
      const effective = effectiveBeat(line);
      if (effective && spent.has(effective) && effective !== interview.callbackBeatId) return true;
      return interview.asked.some((a) => norm(a) === norm(line.say))
        || (goodbyeLocked && isGoodbye(line.say));
    };
    let line = await this.ask(prompt, signal);
    if (!isRepeat(line)) return line;
    const retryPrompt = `${prompt}\n\nYou already covered that. Move to: ${interview.nextBeatGoal || interview.activeBeatLine}`;
    line = await this.ask(retryPrompt, signal);
    if (!isRepeat(line)) return line;
    return interview.fallbackLine;
  }

  private vars(
    scenario: BrainScenario,
    elapsedSeconds: number,
    learnedEscalations: readonly Escalation[] = [],
  ): Record<string, string> {
    const p = persona(scenario);
    return {
      name: p.name,
      outlet: p.outlet,
      temperament: p.temperament,
      agenda: p.agenda,
      public_facts: p.publicFacts.join("; "),
      landmines_known_to_you: landminesText(scenario, p.journalistId, elapsedSeconds, learnedEscalations),
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
      this.log(`[turn] prompt chars=${(prompt + retryNote).length}`);
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
