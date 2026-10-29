import { interviewPlanSchema, isProfileScenario, type InterviewPlan } from "@hot-seat/shared";
import type { Llm } from "../providers/llm.js";
import { fillTemplate, loadPrompt } from "../prompts.js";
import { isGenerated, primaryJournalist, type BrainScenario } from "../journalist.js";
import { buildFallbackPlan, withBeatDefaults } from "./interview-state.js";

export const PLAN_TIMEOUT_MS = 20_000;
export { buildFallbackPlan };

/**
 * One Meta model call for the plan, 20 s timeout. Any failure, timeout or
 * invalid shape returns the deterministic fallback. Never throws.
 */
export async function generateInterviewPlan(
  llm: Pick<Llm, "chat">,
  scenario: BrainScenario,
  opts: { model?: string; timeoutMs?: number; promptTemplate?: string; signal?: AbortSignal } = {},
): Promise<InterviewPlan> {
  try {
    const template = opts.promptTemplate ?? (await loadPrompt("interview-plan.md"));
    const profile = isGenerated(scenario) && isProfileScenario(scenario);
    const j = isGenerated(scenario) ? primaryJournalist(scenario) : null;
    const prompt = fillTemplate(template, {
      name: j?.name ?? (isGenerated(scenario) ? "" : scenario.reporter.name),
      outlet: j?.outlet ?? (isGenerated(scenario) ? "" : scenario.reporter.outlet),
      temperament: j?.temperament ?? (isGenerated(scenario) ? "" : scenario.reporter.temperament),
      agenda: j?.agenda ?? (isGenerated(scenario) ? "" : scenario.reporter.agenda),
      mode: profile ? "profile" : "hot_seat",
      scenario_json: JSON.stringify(scenario),
      public_facts: isGenerated(scenario) ? scenario.public_facts.join("; ") : scenario.publicFacts.join("; "),
      landmines: isGenerated(scenario) ? JSON.stringify(scenario.landmines) : "[]",
    });
    const timeoutMs = opts.timeoutMs ?? PLAN_TIMEOUT_MS;
    const result = await Promise.race([
      llm.chat({ model: opts.model ?? "muse-wonder-1.0", messages: [{ role: "user", content: prompt }], maxTokens: 2000, reasoningEffort: "minimal", timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) }),
      new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("interview plan timed out")), timeoutMs); (t as { unref?: () => void }).unref?.(); }),
    ]);
    const text = typeof result === "string" ? result : result.text;
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no JSON in plan reply");
    const parsed = interviewPlanSchema.parse(JSON.parse(text.slice(start, end + 1)));
    // Enforce unlock times from scenario landmines.
    if (isGenerated(scenario)) {
      for (const beat of parsed.beats) {
        if (beat.landmine_id) {
          const m = scenario.landmines.find((x) => x.id === beat.landmine_id);
          if (m) beat.unlock_at_seconds = m.reveal_after_seconds;
        }
      }
    }
    return withBeatDefaults(parsed);
  } catch {
    return buildFallbackPlan(scenario);
  }
}
