/**
 * Browser-like smoke: talks to a RUNNING server the way Chrome does.
 * Waits out the real playback time of the reporter audio (bytes / 48 per ms
 * at 24 kHz), only then sends playback_done, then streams an ElevenLabs
 * spoken answer at real-time pace. Three turns; fails on any server error.
 * Usage: npm run smoke:browserlike -- [ws://127.0.0.1:3001/ws]
 * Keys are never printed; only their presence is logged.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { ElevenLabsTextToSpeech } from "../src/providers/index.js";
import { presets } from "../src/scenarios/presets.js";
import { voices } from "../src/voices.js";

const wsUrl = process.argv[2] ?? "ws://127.0.0.1:3001/ws";
const httpBase = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
const ANSWERS = [
  "We only noticed the problem that morning. We acted straight away, and we are sorry anyone was worried.",
  "I understand the concern. We checked everything the same day and told our customers what we found.",
  "You are right to ask. We have changed how we work so this does not happen again.",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ev {
  kind: "json" | "audio";
  msg?: { type: string; state?: string; role?: string; text?: string; message?: string; line?: { say: string } };
  bytes?: number;
}

class Channel {
  private queue: Ev[] = [];
  private waiters: Array<(e: Ev) => void> = [];
  push(e: Ev): void {
    const w = this.waiters.shift();
    if (w) w(e);
    else this.queue.push(e);
  }
  async next(timeoutMs = 90_000): Promise<Ev> {
    const q = this.queue.shift();
    if (q) return q;
    return Promise.race([
      new Promise<Ev>((r) => this.waiters.push(r)),
      sleep(timeoutMs).then(() => {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for the server`);
      }),
    ]);
  }
}

async function main(): Promise<void> {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  console.log(`ELEVENLABS_API_KEY: ${elevenKey ? "present" : "MISSING"}`);
  if (!elevenKey) throw new Error("ELEVENLABS_API_KEY is not set in .env");
  const tts = new ElevenLabsTextToSpeech({ apiKey: elevenKey, defaultVoiceId: voices.relentless.male.voiceId });

  // 1) Create a scenario the way the web UI does.
  const preset = presets.find((p) => p.id === "webshop_leak") ?? presets[0]!;
  console.log(`POST ${httpBase}/api/scenarios (${preset.id})`);
  const res = await fetch(`${httpBase}/api/scenarios`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: preset.description, language: "en" }),
  });
  if (!res.ok) throw new Error(`Scenario creation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { id: scenarioId } = (await res.json()) as { id: string };
  console.log(`scenario: ${scenarioId}`);

  // 2) Connect and play the browser for three turns.
  const ch = new Channel();
  const ws = new WebSocket(wsUrl);
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      ch.push({ kind: "audio", bytes: data.length });
      return;
    }
    const msg = JSON.parse(data.toString()) as Ev["msg"];
    console.log(`event: ${JSON.stringify(msg)}`);
    ch.push({ kind: "json", msg });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "start", scenarioId }));

  for (let turn = 0; turn < ANSWERS.length; turn++) {
    // Wait for the reporter line to finish streaming, counting audio bytes.
    let audioBytes = 0;
    for (;;) {
      const ev = await ch.next();
      if (ev.kind === "audio") {
        audioBytes += ev.bytes ?? 0;
        continue;
      }
      if (ev.msg?.type === "error") throw new Error(`Server error: ${ev.msg.message ?? "unknown"}`);
      if (ev.msg?.type === "audio_end") break;
    }
    // Real playback delay: the browser is still playing, sending no mic audio.
    const playbackMs = Math.round(audioBytes / 48);
    console.log(`turn ${turn + 1}: reporter audio ${audioBytes} bytes, playing for ${playbackMs} ms (no mic sent)`);
    await sleep(playbackMs);
    ws.send(JSON.stringify({ type: "playback_done" }));
    console.log("sent: playback_done");

    // Wait until the server says it is listening.
    for (;;) {
      const ev = await ch.next();
      if (ev.msg?.type === "error") throw new Error(`Server error: ${ev.msg.message ?? "unknown"}`);
      if (ev.msg?.type === "state" && ev.msg.state === "listening") break;
    }

    // Speak the answer at real-time pace: 100 ms frames (3200 bytes at 16 kHz).
    const answer = ANSWERS[turn]!;
    const chunks: Uint8Array[] = [];
    for await (const c of tts.synthesize(answer, { outputFormat: "pcm_16000" })) chunks.push(c);
    const pcm = Buffer.concat(chunks);
    console.log(`turn ${turn + 1}: streaming answer (${(pcm.length / 32000).toFixed(1)} s): ${answer}`);
    const FRAME = 3200;
    for (let off = 0; off < pcm.length; off += FRAME) {
      ws.send(new Uint8Array(pcm.subarray(off, off + FRAME)));
      await sleep(100);
    }
    // Trailing silence so endpointing can close the turn.
    const silence = new Uint8Array(FRAME);
    for (let i = 0; i < 20; i++) {
      ws.send(silence);
      await sleep(100);
    }
    console.log(`turn ${turn + 1}: answer streamed, waiting for the reporter`);
  }

  ws.send(JSON.stringify({ type: "stop" }));
  ws.close();
  console.log("smoke:browserlike OK (3 turns, no errors)");
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
