/**
 * Debrief smoke: fixed short transcript on the café fixture, generates the
 * debrief (Muse Wonder medium) and a front page without a photo (Muse Image
 * generation). Prints durations, headline and verdict, writes
 * tmp/front-page.webp. No listening port. Keys are never printed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { DebriefCoach, generateFrontPage } from "../src/debrief.js";
import { MetaImageGen, MetaLlm } from "../src/providers/index.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import type { TimedTurn } from "../src/session/store.js";

const TURNS: TimedTurn[] = [
  {
    role: "reporter",
    text: "Walter, Riverside Courier. When exactly did that display case break?",
    elapsedSeconds: 0,
    flags: [],
  },
  {
    role: "user",
    text: "We knew nothing about the crack. Nobody told me anything that morning.",
    elapsedSeconds: 18,
    flags: ["dodge"],
  },
  {
    role: "reporter",
    text: "The case was taped, not replaced, two days earlier. Who made that call?",
    elapsedSeconds: 42,
    flags: [],
  },
  {
    role: "user",
    text: "Look, we pulled all the pastries as soon as we heard, we closed the case and we called the inspector ourselves. I am sorry this happened.",
    elapsedSeconds: 70,
    flags: ["strong_answer"],
  },
  {
    role: "reporter",
    text: "But you still have not said when you learned about the crack.",
    elapsedSeconds: 105,
    flags: [],
  },
  {
    role: "user",
    text: "I learned that morning, after the post went up. That is on me, I should have checked the case myself.",
    elapsedSeconds: 128,
    flags: [],
  },
];

async function main(): Promise<void> {
  const key = process.env.MODEL_API_KEY;
  console.log(`MODEL_API_KEY: ${key ? "present" : "MISSING"}`);
  if (!key) throw new Error("MODEL_API_KEY is not set in .env");

  const coach = new DebriefCoach(
    new MetaLlm({ apiKey: key, structuredModel: "muse-wonder-1.0" }),
    "muse-wonder-1.0",
    "medium",
  );
  const debriefStarted = performance.now();
  const debrief = await coach.generate(cafeTestScenario, TURNS, "en");
  const debriefSeconds = ((performance.now() - debriefStarted) / 1000).toFixed(1);
  console.log(`debrief time: ${debriefSeconds} s`);
  console.log(`headline: ${debrief.front_page.headline}`);
  console.log(`subhead: ${debrief.front_page.subhead}`);
  console.log(`verdict: ${debrief.verdict}`);
  console.log(
    `scores: clarity ${debrief.scores.clarity}, accountability ${debrief.scores.accountability}, ` +
      `composure ${debrief.scores.composure}, message_discipline ${debrief.scores.message_discipline}, empathy ${debrief.scores.empathy}`,
  );

  const imageGen = new MetaImageGen({ apiKey: key });
  const imageStarted = performance.now();
  const front = await generateFrontPage(imageGen, debrief, cafeTestScenario, null);
  const imageSeconds = ((performance.now() - imageStarted) / 1000).toFixed(1);
  console.log(`front page time: ${imageSeconds} s (${front.mimeType}, ${front.image.length} bytes)`);

  const outDir = path.resolve(here, "../../tmp");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "front-page.webp");
  await writeFile(outFile, front.image);
  console.log("written to tmp/front-page.webp");
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
