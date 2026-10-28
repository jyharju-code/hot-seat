/**
 * Scenario speed smoke: generates cafe_food and contractor_delay with three
 * model/reasoning configurations, records time and JSON validity, and writes
 * each raw output to tmp/speed/<config>-<preset>.json. No listening port.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { generatedScenarioSchema } from "@hot-seat/shared";
import { MetaLlm } from "../src/providers/index.js";
import { fillTemplate, loadPrompt } from "../src/prompts.js";
import { presets } from "../src/scenarios/presets.js";

const CONFIGS = [
  { id: "wonder-medium", model: "muse-wonder-1.0", reasoning: "medium" },
  { id: "wonder-low", model: "muse-wonder-1.0", reasoning: "low" },
  { id: "spark-low", model: "muse-spark-1.3", reasoning: "low" },
] as const;

const PRESET_IDS = ["cafe_food", "contractor_delay"] as const;

async function main(): Promise<void> {
  const key = process.env.MODEL_API_KEY;
  console.log(`MODEL_API_KEY: ${key ? "present" : "MISSING"}`);
  if (!key) throw new Error("MODEL_API_KEY is not set in .env");
  const llm = new MetaLlm({ apiKey: key });
  const [template, spokenStyle] = await Promise.all([loadPrompt("crisis-director.md"), loadPrompt("spoken-style.md")]);
  const outDir = path.resolve(here, "../../tmp/speed");
  await mkdir(outDir, { recursive: true });

  const rows: Array<{ config: string; preset: string; seconds: number; valid: boolean }> = [];
  for (const cfg of CONFIGS) {
    const system = fillTemplate(template, { language: "en", spoken_style: spokenStyle.trim() });
    for (const presetId of PRESET_IDS) {
      const preset = presets.find((p) => p.id === presetId);
      if (!preset) throw new Error(`preset not found: ${presetId}`);
      let captured: unknown = null;
      let valid = false;
      const started = performance.now();
      try {
        await llm.generateStructured({
          prompt: preset.description,
          system,
          model: cfg.model,
          reasoningEffort: cfg.reasoning,
          parse: (raw) => {
            captured = raw;
            const parsed = generatedScenarioSchema.parse(raw);
            valid = true;
            return parsed;
          },
        });
      } catch (err) {
        console.log(`  ${cfg.id} ${presetId}: failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        if (captured === null) captured = { error: err instanceof Error ? err.message : String(err) };
      }
      const seconds = (performance.now() - started) / 1000;
      const outFile = path.join(outDir, `${cfg.id}-${presetId}.json`);
      await writeFile(outFile, JSON.stringify(captured, null, 2));
      rows.push({ config: cfg.id, preset: presetId, seconds, valid });
      console.log(`${cfg.id} ${presetId}: ${seconds.toFixed(1)} s valid=${valid} -> tmp/speed/${cfg.id}-${presetId}.json`);
    }
  }
  console.log("\n| config | preset | time (s) | valid JSON |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.config} | ${r.preset} | ${r.seconds.toFixed(1)} | ${r.valid ? "yes" : "no"} |`);
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
