/**
 * Latency smoke: 6 journalist turns on a fixed scenario and answer, for each
 * turn provider (Meta and Baseten). Prints median and worst time to complete
 * valid JSON and the share of valid JSON. No listening port, keys never printed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { JournalistBrain, loadJournalistPrompts, parseReporterLine } from "../src/journalist.js";
import { BasetenLlm, MetaLlm } from "../src/providers/index.js";
import type { Llm } from "../src/providers/llm.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";

const ANSWER =
  "We knew nothing about the crack that morning. We pulled the pastries, closed the case, and called the inspector ourselves.";
const TURNS = 6;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function runProvider(name: string, llm: Llm, model: string): Promise<{ name: string; medianMs: number; worstMs: number; validShare: number; times: number[] }> {
  const prompts = await loadJournalistPrompts();
  const brain = new JournalistBrain(llm, prompts, model);
  const times: number[] = [];
  let valid = 0;
  for (let i = 0; i < TURNS; i++) {
    const started = performance.now();
    try {
      const line = await brain.nextTurn(cafeTestScenario, [], ANSWER, 90);
      parseReporterLine(JSON.stringify(line));
      valid += 1;
      times.push(performance.now() - started);
    } catch (err) {
      times.push(performance.now() - started);
      console.log(`  ${name} turn ${i + 1}: INVALID (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
    }
    console.log(`  ${name} turn ${i + 1}: ${Math.round(times[times.length - 1]!)} ms`);
  }
  return { name, medianMs: median(times), worstMs: Math.max(...times), validShare: valid / TURNS, times };
}

async function main(): Promise<void> {
  const modelKey = process.env.MODEL_API_KEY;
  const basetenKey = process.env.BASETEN_API_KEY;
  console.log(`MODEL_API_KEY: ${modelKey ? "present" : "MISSING"}`);
  console.log(`BASETEN_API_KEY: ${basetenKey ? "present" : "MISSING"}`);
  const results = [];
  if (modelKey) {
    results.push(await runProvider("meta", new MetaLlm({ apiKey: modelKey }), process.env.LLM_CHAT_MODEL ?? "muse-spark-1.3"));
  }
  if (basetenKey) {
    results.push(await runProvider("baseten", new BasetenLlm({ apiKey: basetenKey }), "meta-models/muse-spark-open-1026"));
  }
  if (results.length === 0) throw new Error("No provider key is set");
  console.log("\n| provider | median (ms) | worst (ms) | valid JSON |");
  console.log("|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.name} | ${Math.round(r.medianMs)} | ${Math.round(r.worstMs)} | ${Math.round(r.validShare * 100)}% (${Math.round(r.validShare * TURNS)}/${TURNS}) |`);
  }
  const meta = results.find((r) => r.name === "meta");
  const baseten = results.find((r) => r.name === "baseten");
  if (meta && baseten) {
    const faster = (((meta.medianMs - baseten.medianMs) / meta.medianMs) * 100).toFixed(1);
    console.log(`baseten vs meta median: ${faster}% faster`);
    console.log(`baseten qualifies for default (>=30% faster, all valid): ${baseten.validShare === 1 && baseten.medianMs <= meta.medianMs * 0.7 ? "yes" : "no"}`);
  }
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
