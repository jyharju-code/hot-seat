import { generatedScenarioSchema, type GeneratedScenario } from "@hot-seat/shared";
import type { Llm } from "../providers/llm.js";
import { fillTemplate, loadPrompt } from "../prompts.js";

export type ScenarioGenerator = (description: string, language: string) => Promise<GeneratedScenario>;

/**
 * Crisis Director: builds a fictional scenario with Muse Wonder via the
 * structured method of the Llm port. The user description is the user
 * message (the prompt argument), never part of the system prompt.
 */
export class CrisisDirector {
  private readonly llm: Llm;
  private readonly model: string | undefined;

  constructor(llm: Llm, model?: string) {
    this.llm = llm;
    this.model = model;
  }

  async generate(description: string, language = "en"): Promise<GeneratedScenario> {
    const [template, spokenStyle] = await Promise.all([
      loadPrompt("crisis-director.md"),
      loadPrompt("spoken-style.md"),
    ]);
    const system = fillTemplate(template, { language, spoken_style: spokenStyle.trim() });
    return this.llm.generateStructured({
      prompt: description,
      system,
      ...(this.model ? { model: this.model } : {}),
      parse: (raw) => generatedScenarioSchema.parse(raw),
    });
  }
}
