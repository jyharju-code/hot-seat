/**
 * Synthetic owners: an AI plays the business owner out loud at real-time
 * pace against a RUNNING server, and we measure fluency per turn.
 * Usage: npm run sim -- --profiles all|a,b --turns 4 --concurrency 3 --preset cafe_food --debrief
 * Keys are never printed; only their presence is logged.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env") });
loadDotenv();

import { ElevenLabsTextToSpeech, MetaLlm } from "../../src/providers/index.js";
import { presets, profilePresets } from "../../src/scenarios/presets.js";
import { OwnerAgent } from "./owner.js";
import { SimSession, type SessionResult } from "./client.js";
import { buildReport, summarize, summaryTable } from "./report.js";
import { OWNER_VOICES, type OwnerVoiceGender } from "./voice.js";

/** Rough upfront estimate per owner answer, for the cost guard. */
export const ESTIMATED_CHARS_PER_TURN = 600;
/** A friendly profile invites longer answers: estimate more TTS per turn. */
export const ESTIMATED_CHARS_PER_PROFILE_TURN = 900;
export const DEFAULT_MAX_CHARS = 20_000;

export interface SimArgs {
  url: string;
  profiles: string;
  turns: number;
  concurrency: number;
  preset: string;
  debrief: boolean;
  maxChars: number;
  mode: "hot_seat" | "profile";
  duration: 5 | 10;
}

export function parseArgs(argv: readonly string[]): SimArgs {
  const args: SimArgs = {
    url: "ws://127.0.0.1:3001/ws",
    profiles: "all",
    turns: 4,
    concurrency: 3,
    preset: "cafe_food",
    debrief: false,
    maxChars: DEFAULT_MAX_CHARS,
    mode: "hot_seat",
    duration: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--url") args.url = value();
    else if (arg === "--profiles") args.profiles = value();
    else if (arg === "--turns") args.turns = positiveInt(arg, value());
    else if (arg === "--concurrency") args.concurrency = positiveInt(arg, value());
    else if (arg === "--preset") args.preset = value();
    else if (arg === "--max-chars") args.maxChars = positiveInt(arg, value());
    else if (arg === "--debrief") args.debrief = true;
    else if (arg === "--mode") {
      const v = value();
      if (v !== "hot_seat" && v !== "profile") throw new Error(`--mode must be hot_seat or profile, got ${v}`);
      args.mode = v;
    } else if (arg === "--duration") {
      const n = positiveInt(arg, value());
      if (n !== 5 && n !== 10) throw new Error(`--duration must be 5 or 10, got ${n}`);
      args.duration = n;
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got ${raw}`);
  return n;
}

/** Cost guard: estimate TTS characters before any session starts. */
export function estimateTotalChars(profileCount: number, turns: number, mode: "hot_seat" | "profile" = "hot_seat", durationMinutes = 5): number {
  if (mode === "profile") {
    // A timed profile keeps talking until its minutes run out: expect at
    // least one answer per 30 seconds, each longer than a crisis answer.
    const expectedTurns = Math.max(turns, durationMinutes * 2);
    return profileCount * expectedTurns * ESTIMATED_CHARS_PER_PROFILE_TURN;
  }
  return profileCount * turns * ESTIMATED_CHARS_PER_TURN;
}

async function loadProfiles(selected: string): Promise<Array<{ name: string; text: string }>> {
  const dir = path.join(here, "profiles");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const names = files.map((f) => f.replace(/\.md$/, ""));
  const wanted = selected === "all" ? names : selected.split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of wanted) {
    if (!names.includes(name)) throw new Error(`unknown profile ${name} (have: ${names.join(", ")})`);
  }
  return Promise.all(
    wanted.map(async (name) => ({ name, text: await readFile(path.join(dir, `${name}.md`), "utf8") })),
  );
}

/** Deterministic stable voice per session: alternate by profile index. */
const voiceForIndex = (i: number): { gender: OwnerVoiceGender; voiceId: string } => {
  const gender: OwnerVoiceGender = i % 2 === 0 ? "male" : "female";
  return { gender, voiceId: OWNER_VOICES[gender] };
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelKey = process.env.MODEL_API_KEY;
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  console.log(`MODEL_API_KEY: ${modelKey ? "present" : "MISSING"}`);
  console.log(`ELEVENLABS_API_KEY: ${elevenKey ? "present" : "MISSING"}`);
  if (!modelKey) throw new Error("MODEL_API_KEY is not set in .env");
  if (!elevenKey) throw new Error("ELEVENLABS_API_KEY is not set in .env");

  const profiles = await loadProfiles(args.profiles);
  const allPresets = [...presets, ...profilePresets];
  const preset = args.mode === "profile" && args.preset === "cafe_food"
    ? profilePresets[0]!
    : allPresets.find((p) => p.id === args.preset);
  if (!preset) throw new Error(`unknown preset ${args.preset} (have: ${allPresets.map((p) => p.id).join(", ")})`);

  const estimated = estimateTotalChars(profiles.length, args.turns, args.mode, args.duration);
  const perTurn = args.mode === "profile" ? ESTIMATED_CHARS_PER_PROFILE_TURN : ESTIMATED_CHARS_PER_TURN;
  console.log(
    `TTS estimate: ${profiles.length} profiles x ${args.turns} turns x ~${perTurn} chars = ${estimated} chars (cap ${args.maxChars}) mode=${args.mode} duration=${args.duration}`,
  );
  if (estimated > args.maxChars) {
    throw new Error(`estimate ${estimated} chars exceeds --max-chars ${args.maxChars}; raise the cap to run`);
  }
  let chargedChars = 0;
  const chargeChars = (chars: number) => {
    chargedChars += chars;
    if (chargedChars > args.maxChars) {
      throw new Error(`TTS characters ${chargedChars} exceeded --max-chars ${args.maxChars}; aborting`);
    }
  };

  const httpBase = args.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  const owner = new OwnerAgent(new MetaLlm({ apiKey: modelKey, chatModel: "muse-spark-1.3", chatTimeoutMs: 60_000, structuredTimeoutMs: 60_000 }), "muse-spark-1.3");
  const tts = new ElevenLabsTextToSpeech({ apiKey: elevenKey, defaultVoiceId: OWNER_VOICES.male });

  const results: SessionResult[] = new Array<SessionResult>(profiles.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= profiles.length) return;
      const profile = profiles[index]!;
      const voice = voiceForIndex(index);
      const session = new SimSession({
        wsUrl: args.url,
        httpBase,
        presetId: preset.id,
        presetDescription: preset.description,
        profileName: profile.name,
        profileText: profile.text,
        turns: args.turns,
        mode: args.mode,
        durationMinutes: args.duration,
        owner,
        tts,
        voiceId: voice.voiceId,
        chargeChars,
        debrief: args.debrief && index === 0,
        log: (line) => console.log(line),
      });
      results[index] = await session.run();
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, profiles.length) }, () => worker()));

  const at = new Date().toISOString();
  const outDir = path.resolve(here, "../../../sim-results", at.replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  const summaries = summarize(results);
  await writeFile(path.join(outDir, "results.json"), JSON.stringify({ at, args, summaries, sessions: results }, null, 2));
  await writeFile(path.join(outDir, "report.md"), buildReport(results, { preset: preset.id, turns: args.turns, at }));
  console.log(summaryTable(summaries));
  console.log(`TTS characters used: ${chargedChars}`);
  console.log(`written: ${path.join(outDir, "report.md")}`);
  if (results.some((r) => r.failure)) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`sim failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
