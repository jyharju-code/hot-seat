import {
  debriefSchema,
  type Debrief,
  type GeneratedScenario,
} from "@hot-seat/shared";
import { MIN_REASONING_MAX_TOKENS, type Llm } from "./providers/llm.js";
import type { ImageGen, ImageResult } from "./providers/image-gen.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import { formatEvents, formatTranscript, type TimedTurn } from "./session/store.js";

export interface DebriefLandmineInput {
  id: string;
  fact: string;
  owner_knows: boolean;
  reveal_after_seconds: number;
  /** True when the reporter had learned this landmine by the end of the session. */
  revealed_to_reporter: boolean;
}

/** Elapsed session length in seconds, from the last turn (0 when there are no turns). */
export function sessionLengthSeconds(turns: readonly TimedTurn[]): number {
  return turns.reduce((max, t) => Math.max(max, t.elapsedSeconds), 0);
}

/** Per-landmine debrief input: who knew it, and whether it was revealed in time. */
export function debriefLandmineInputs(
  scenario: GeneratedScenario,
  elapsedSeconds: number,
): DebriefLandmineInput[] {
  return scenario.landmines.map((m) => ({
    id: m.id,
    fact: m.fact,
    owner_knows: m.owner_knows,
    reveal_after_seconds: m.reveal_after_seconds,
    revealed_to_reporter: m.reveal_after_seconds <= elapsedSeconds,
  }));
}

export type DebriefGenerator = (
  scenario: GeneratedScenario,
  turns: readonly TimedTurn[],
  language?: string,
) => Promise<Debrief>;

/** Debrief coach: Muse Wonder (structured, medium) validated with zod. */
export class DebriefCoach {
  private readonly llm: Llm;
  private readonly model: string;
  private readonly reasoningEffort: string;

  constructor(llm: Llm, model = "muse-wonder-1.0", reasoningEffort = "medium") {
    this.llm = llm;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  async generate(
    scenario: GeneratedScenario,
    turns: readonly TimedTurn[],
    language = "en",
  ): Promise<Debrief> {
    const template = await loadPrompt("debrief.md");
    const elapsed = sessionLengthSeconds(turns);
    const prompt = fillTemplate(template, {
      scenario_json: JSON.stringify(scenario),
      session_length_seconds: String(elapsed),
      landmine_context: JSON.stringify(debriefLandmineInputs(scenario, elapsed)),
      transcript: formatTranscript(turns),
      events: formatEvents(turns),
      language,
    });
    return this.llm.generateStructured({
      prompt,
      // Structured JSON plus reasoning: well above the minimum.
      maxTokens: Math.max(8000, MIN_REASONING_MAX_TOKENS),
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      parse: (raw) => debriefSchema.parse(raw),
    });
  }
}

/** Build the front-page image prompt from prompts/front-page.md. */
export async function buildFrontPagePrompt(
  debrief: Debrief,
  scenario: GeneratedScenario,
  hasPhoto: boolean,
  tomorrow = tomorrowDateString(),
): Promise<string> {
  const template = await loadPrompt("front-page.md");
  const paperStyle =
    scenario.format === "press_conference"
      ? "a serious national broadsheet newspaper"
      : "a local newspaper";
  const paperName = scenario.journalists[0]?.outlet ?? "The Local Courier";
  const quoteTexts = [debrief.headline_quote, debrief.best_moments[0]?.quote]
    .map((q) => q?.trim())
    .filter((q): q is string => Boolean(q));
  const uniqueQuotes = [...new Set(quoteTexts)];
  const quotes = uniqueQuotes.map((q) => `"${q}" (the owner)`).join(", ");
  let prompt = fillTemplate(template, {
    paper_style: paperStyle,
    fictional_paper_name: paperName,
    tomorrow,
    headline: debrief.front_page.headline,
    subhead: debrief.front_page.subhead,
    company_name: scenario.company.name,
    crisis_summary: scenario.crisis.summary,
    key_facts: scenario.public_facts.slice(0, 5).join("; "),
    quotes,
  });
  if (!hasPhoto) {
    // No camera still: describe the lead photo instead of referencing one.
    prompt = prompt
      .replace(
        /^Turn this photo into /m,
        "Create ",
      )
      .replace(
        "Use this exact photo as the large lead image, styled as press photography.",
        `Use as the large lead image a press photograph of the storefront of ${scenario.company.name}, with reporters and microphones outside, people seen from behind, styled as press photography.`,
      );
  }
  return prompt;
}

export function tomorrowDateString(now = new Date()): string {
  const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export interface FrontPageRequest {
  still?: { image: Uint8Array; mimeType: string } | null;
}

/** Generate (no still) or edit (with still) the front page via the ImageGen port. */
export async function generateFrontPage(
  imageGen: ImageGen,
  debrief: Debrief,
  scenario: GeneratedScenario,
  still?: { image: Uint8Array; mimeType: string } | null,
): Promise<ImageResult> {
  const prompt = await buildFrontPagePrompt(debrief, scenario, Boolean(still));
  if (still) {
    return imageGen.editPhoto({ image: still.image, mimeType: still.mimeType, prompt });
  }
  return imageGen.generateImage(prompt);
}
