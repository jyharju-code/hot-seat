import { generatedScenarioSchema, type DurationMinutes, type GeneratedScenario } from "@hot-seat/shared";
import { MIN_REASONING_MAX_TOKENS, type Llm } from "../providers/llm.js";
import { SCENARIO_TIMEOUT_MS, isTimeoutOrNetworkError } from "../providers/timeout.js";
import { fillTemplate, loadPrompt } from "../prompts.js";

export type ScenarioMode = "hot_seat" | "profile";
export interface ScenarioOptions {
  mode?: ScenarioMode;
  durationMinutes?: DurationMinutes;
}

export type ScenarioGenerator = (
  description: string,
  language?: string,
  options?: ScenarioOptions,
) => Promise<GeneratedScenario>;

/** Force the profile invariants, whatever the model returned. */
export function normalizeProfileScenario(scenario: GeneratedScenario, durationMinutes: DurationMinutes = 5): GeneratedScenario {
  return {
    ...scenario,
    format: "profile",
    duration_minutes: durationMinutes,
    escalations: [],
    landmines: scenario.landmines.slice(0, 3).map((m) => ({ ...m, owner_knows: true, who_knows: "none", reveal_after_seconds: 9999 })),
    journalists: scenario.journalists.slice(0, 1).map((j) => ({ ...j, temperament: "human" as const })),
  };
}

export class CrisisDirector {
  private readonly llm: Llm;
  private readonly model: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(llm: Llm, model?: string, reasoningEffort?: string, timeoutMs: number = SCENARIO_TIMEOUT_MS, log?: (line: string) => void) {
    this.llm = llm;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
    this.log = log ?? (() => undefined);
  }

  async generate(description: string, language = "en", options: ScenarioOptions = {}): Promise<GeneratedScenario> {
    const isProfile = options.mode === "profile";
    const duration = options.durationMinutes ?? 5;
    const [template, spokenStyle] = await Promise.all([
      loadPrompt(isProfile ? "profile-director.md" : "crisis-director.md"),
      loadPrompt("spoken-style.md"),
    ]);
    const system = fillTemplate(template, { language, spoken_style: spokenStyle.trim() });
    // One retry on timeout / network error, 60 s per attempt (as debrief).
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const scenario = await this.llm.generateStructured({
          prompt: description,
          system,
          maxTokens: Math.max(8000, MIN_REASONING_MAX_TOKENS),
          ...(this.model ? { model: this.model } : {}),
          ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
          timeoutMs: this.timeoutMs,
          parse: (raw) => generatedScenarioSchema.parse(raw),
        });
        return isProfile ? normalizeProfileScenario(scenario, duration) : scenario;
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isTimeoutOrNetworkError(err)) {
          this.log("[scenario] timeout, retrying");
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
