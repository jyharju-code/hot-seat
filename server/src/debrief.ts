import {
  FRONT_PAGE_STEPS,
  debriefSchema,
  isProfileScenario,
  nextFrontPageStep,
  type Debrief,
  type FrontPageResult,
  type FrontPageStep,
  type GeneratedScenario,
} from "@hot-seat/shared";
import { MIN_REASONING_MAX_TOKENS, type Llm } from "./providers/llm.js";
import { isTimeoutOrNetworkError, DEBRIEF_TIMEOUT_MS } from "./providers/timeout.js";
import { classifyImageError, type ImageGen, type ImageResult } from "./providers/image-gen.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import { formatEvents, formatHarvestedQuotes, formatTranscript, harvestedQuotes, type TimedTurn } from "./session/store.js";

export { harvestedQuotes };

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
  const profile = isProfileScenario(scenario);
  return scenario.landmines.map((m) => ({
    id: m.id,
    fact: m.fact,
    owner_knows: m.owner_knows,
    reveal_after_seconds: m.reveal_after_seconds,
    revealed_to_reporter: profile ? false : m.reveal_after_seconds <= elapsedSeconds,
  }));
}

export type DebriefGenerator = (
  scenario: GeneratedScenario,
  turns: readonly TimedTurn[],
  language?: string,
  interviewMap?: string,
) => Promise<Debrief>;

/** Debrief coach: Muse Wonder (structured, medium) validated with zod. */
export class DebriefCoach {
  private readonly llm: Llm;
  private readonly model: string;
  private readonly reasoningEffort: string;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(llm: Llm, model = "muse-wonder-1.0", reasoningEffort = "medium", log?: (line: string) => void, timeoutMs: number = DEBRIEF_TIMEOUT_MS) {
    this.llm = llm;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.log = log ?? (() => undefined);
    this.timeoutMs = timeoutMs;
  }

  async generate(
    scenario: GeneratedScenario,
    turns: readonly TimedTurn[],
    language = "en",
    interviewMap = "",
  ): Promise<Debrief> {
    const template = await loadPrompt("debrief.md");
    const coachKnowledge = await loadPrompt("coach-knowledge.md");
    const elapsed = sessionLengthSeconds(turns);
    const prompt = fillTemplate(template, {
      coach_knowledge: coachKnowledge,
      mode: isProfileScenario(scenario) ? "profile" : "hot_seat",
      scenario_json: JSON.stringify(scenario),
      session_length_seconds: String(elapsed),
      landmine_context: JSON.stringify(debriefLandmineInputs(scenario, elapsed)),
      transcript: formatTranscript(turns),
      events: formatEvents(turns),
      harvested_quotes: formatHarvestedQuotes(turns),
      interview_map: interviewMap || "(no interview map)",
      language,
    });
    this.log(`[debrief] prompt chars=${prompt.length}`);
    // One retry on timeout / network error: worst case 2 x timeout (about 3 min at 90 s).
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const callStarted = performance.now();
      try {
        const result = await this.llm.generateStructured({
          prompt,
          // Structured JSON plus reasoning: well above the minimum.
          maxTokens: Math.max(8000, MIN_REASONING_MAX_TOKENS),
          model: this.model,
          reasoningEffort: this.reasoningEffort,
          timeoutMs: this.timeoutMs,
          parse: (raw) => debriefSchema.parse(raw),
        });
        this.log(`[debrief] model call ${Math.round(performance.now() - callStarted)}ms`);
        return result;
      } catch (err) {
        lastErr = err;
        const elapsed = Math.round(performance.now() - callStarted);
        if (attempt === 0 && isTimeoutOrNetworkError(err)) {
          this.log(`[debrief] timeout after ${elapsed}ms, retrying`);
          continue;
        }
        this.log(`[debrief] model call failed after ${elapsed}ms`);
        throw err;
      }
    }
    throw lastErr;
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
  const profile = isProfileScenario(scenario);
  const paperStyle = profile
    ? "a friendly local newspaper feature page, warm and smiling in layout"
    : scenario.format === "press_conference"
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
  if (profile) {
    prompt += `\nThis is a friendly feature page, not a crisis page: warm layout, the owner smiling in the large lead photo, anniversary warmth in the design. Print the headline and pull quote exactly as given above.`;
  }
  if (!hasPhoto) {
    // No camera still: describe the lead photo instead of referencing one.
    prompt = prompt
      .replace(
        /^Turn this photo into /m,
        "Create ",
      )
      .replace(
        "Use this exact photo as the large lead image, styled as press photography.",
        profile
          ? `Use as the large lead image a warm press photograph of the smiling owner outside ${scenario.company.name}, styled as friendly feature photography.`
          : `Use as the large lead image a press photograph of the storefront of ${scenario.company.name}, with reporters and microphones outside, people seen from behind, styled as press photography.`,
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

function paperStyleFor(scenario: GeneratedScenario): string {
  if (isProfileScenario(scenario)) return "a friendly local newspaper feature page, warm and smiling in layout";
  return scenario.format === "press_conference" ? "a serious national broadsheet newspaper" : "a local newspaper";
}

function paperNameFor(scenario: GeneratedScenario): string {
  return scenario.journalists[0]?.outlet ?? "The Local Courier";
}

function frontPageQuotes(debrief: Debrief): string[] {
  const texts = [debrief.headline_quote, debrief.best_moments[0]?.quote]
    .map((q) => q?.trim())
    .filter((q): q is string => Boolean(q));
  return [...new Set(texts)];
}

/**
 * Minimal front-page prompt: layout, paper name, date, headline and subhead
 * only. No story summary, facts or quotes. Headline and subhead stay verbatim.
 */
export async function buildMinimalFrontPagePrompt(
  debrief: Debrief,
  scenario: GeneratedScenario,
  variant: "photo" | "storefront",
  tomorrow = tomorrowDateString(),
): Promise<string> {
  const template = await loadPrompt("front-page-minimal.md");
  const leadImage =
    variant === "photo"
      ? "Use this exact photo as the large lead image, styled as press photography. Keep the person's expression and pose unchanged."
      : `Use as the large lead image a photograph of the storefront of ${scenario.company.name}, styled as press photography.`;
  return fillTemplate(template, {
    paper_style: paperStyleFor(scenario),
    fictional_paper_name: paperNameFor(scenario),
    tomorrow,
    headline: debrief.front_page.headline,
    subhead: debrief.front_page.subhead,
    lead_image: leadImage,
  });
}

/** HTML-fallback payload rendered in the browser as a newspaper front page. */
export function buildHtmlFrontPage(
  debrief: Debrief,
  scenario: GeneratedScenario,
  still?: { image: Uint8Array; mimeType: string } | null,
  tomorrow = tomorrowDateString(),
): FrontPageResult {
  return {
    kind: "html",
    step: "html",
    paperName: paperNameFor(scenario),
    date: tomorrow,
    headline: debrief.front_page.headline,
    subhead: debrief.front_page.subhead,
    companyName: scenario.company.name,
    summary: scenario.crisis.summary,
    keyFacts: scenario.public_facts.slice(0, 5),
    quotes: frontPageQuotes(debrief),
    photoBase64: still ? Buffer.from(still.image).toString("base64") : null,
    photoMime: still ? still.mimeType : null,
    profile: isProfileScenario(scenario),
  };
}

export interface GenerateFrontPageOptions {
  startStep?: FrontPageStep;
  log?: (line: string) => void;
  tomorrow?: string;
}

export interface FrontPageOutcome {
  frontPage: FrontPageResult;
  step: FrontPageStep;
  nextStep: FrontPageStep | null;
}

function imageOutcome(result: ImageResult, step: Exclude<FrontPageStep, "html">): FrontPageOutcome {
  return {
    frontPage: {
      kind: "image",
      imageBase64: Buffer.from(result.image).toString("base64"),
      mime: result.mimeType,
      step,
    },
    step,
    nextStep: nextFrontPageStep(step),
  };
}

/**
 * Front-page fallback ladder. Never throws: filtered or 4xx steps move down
 * to a minimal edit, then a storefront generation, then an HTML page.
 */
export async function generateFrontPage(
  imageGen: ImageGen,
  debrief: Debrief,
  scenario: GeneratedScenario,
  still?: { image: Uint8Array; mimeType: string } | null,
  options: GenerateFrontPageOptions = {},
): Promise<FrontPageOutcome> {
  const log = options.log ?? (() => undefined);
  const tomorrow = options.tomorrow ?? tomorrowDateString();
  const start = options.startStep ?? "edit_full";
  const steps = FRONT_PAGE_STEPS.slice(FRONT_PAGE_STEPS.indexOf(start));
  for (const step of steps) {
    if (step === "html") {
      log(`[front-page] step=html result=ok promptLength=0`);
      return { frontPage: buildHtmlFrontPage(debrief, scenario, still, tomorrow), step: "html", nextStep: null };
    }
    if (step === "edit_minimal" && !still) continue;
    let prompt: string;
    try {
      prompt =
        step === "edit_full"
          ? await buildFrontPagePrompt(debrief, scenario, Boolean(still), tomorrow)
          : await buildMinimalFrontPagePrompt(
              debrief,
              scenario,
              step === "generate_storefront" ? "storefront" : "photo",
              tomorrow,
            );
    } catch {
      log(`[front-page] step=${step} result=error promptLength=0`);
      continue;
    }
    // One retry on timeout / network error before falling down the ladder.
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptStarted = performance.now();
      try {
        const result =
          step === "generate_storefront" || !still
            ? await imageGen.generateImage(prompt)
            : await imageGen.editPhoto({ image: still.image, mimeType: still.mimeType, prompt });
        log(`[front-page] step=${step} result=ok promptLength=${prompt.length}`);
        return imageOutcome(result, step);
      } catch (err) {
        const elapsed = Math.round(performance.now() - attemptStarted);
        if (attempt === 0 && isTimeoutOrNetworkError(err)) {
          log(`[front-page] timeout after ${elapsed}ms, retrying`);
          continue;
        }
        log(`[front-page] step=${step} result=${classifyImageError(err)} promptLength=${prompt.length}`);
        break;
      }
    }
  }
  log(`[front-page] step=html result=ok promptLength=0`);
  return { frontPage: buildHtmlFrontPage(debrief, scenario, still, tomorrow), step: "html", nextStep: null };
}
