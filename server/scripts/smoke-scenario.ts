/**
 * Scenario smoke test: generates the webshop_leak preset with real Muse
 * Wonder, prints timing and the key fields, writes JSON to tmp/scenario.json.
 * No listening port. Keys are never printed; only their presence is logged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { MetaLlm } from "../src/providers/index.js";
import { CrisisDirector } from "../src/scenarios/director.js";
import { presets } from "../src/scenarios/presets.js";

async function main(): Promise<void> {
  const key = process.env.MODEL_API_KEY;
  console.log(`MODEL_API_KEY: ${key ? "present" : "MISSING"}`);
  if (!key) throw new Error("MODEL_API_KEY is not set in .env");
  const preset = presets.find((p) => p.id === "webshop_leak");
  if (!preset) throw new Error("webshop_leak preset not found");
  console.log(`preset: ${preset.id} (${preset.label})`);
  console.log(`description: ${preset.description}`);

  const director = new CrisisDirector(new MetaLlm({ apiKey: key }), "muse-wonder-1.0");
  const started = performance.now();
  const scenario = await director.generate(preset.description, "en");
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`generation time: ${seconds} s`);
  console.log(`company: ${scenario.company.name} (${scenario.company.city})`);
  console.log(`headline: ${scenario.crisis.headline}`);
  console.log("briefing:");
  for (const point of scenario.briefing_for_user) console.log(`  - ${point}`);
  const first = scenario.journalists[0];
  console.log(`opening question (${first?.name}, ${first?.outlet}): ${first?.opening_question}`);

  const outDir = path.resolve(here, "../../tmp");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "scenario.json");
  await writeFile(outFile, JSON.stringify(scenario, null, 2));
  console.log(`written to tmp/scenario.json`);
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
