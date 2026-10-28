/**
 * Live voice-loop smoke test: no browser, no listening port.
 * ElevenLabs speaks an "owner" answer (PCM 16 kHz), the real STT adapter
 * transcribes it, the real journalist prompt replies, ElevenLabs speaks the
 * reply (PCM 24 kHz) and the reply is written to tmp/smoke-reply.wav.
 * Keys are never printed; only their presence is logged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../.env") });
loadDotenv();

import { JournalistBrain, loadJournalistPrompts } from "../src/journalist.js";
import { ElevenLabsTextToSpeech, MetaLlm, MuseSpeechToText } from "../src/providers/index.js";
import type { SttEvent } from "../src/providers/index.js";
import { cafeScenario } from "../src/scenarios/cafe.js";
import { voices } from "../src/voices.js";

const OWNER_LINE =
  "Look, nobody told me the display case was cracked. We only noticed it that morning, and we pulled the pastries straight away.";

function requireKey(name: string): string {
  const v = process.env[name];
  console.log(`${name}: ${v ? "present" : "MISSING"}`);
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const modelKey = requireKey("MODEL_API_KEY");
  const elevenKey = requireKey("ELEVENLABS_API_KEY");
  const voice = voices.relentless;
  const tts = new ElevenLabsTextToSpeech({ apiKey: elevenKey, defaultVoiceId: voice.voiceId });

  // 1) Synthesize the owner answer at 16 kHz for the STT adapter.
  const tSynth0 = performance.now();
  const ownerChunks: Uint8Array[] = [];
  for await (const chunk of tts.synthesize(OWNER_LINE, { outputFormat: "pcm_16000" })) ownerChunks.push(chunk);
  const ownerPcm = Buffer.concat(ownerChunks);
  console.log(
    `owner audio: ${ownerPcm.length} bytes PCM16 16kHz (${(ownerPcm.length / 32000).toFixed(1)}s) in ${Math.round(performance.now() - tSynth0)}ms`,
  );
  console.log(`owner line: ${OWNER_LINE}`);

  // 2) Stream it through the real STT adapter, paced in ~100 ms frames.
  const stt = new MuseSpeechToText({ apiKey: modelKey, log: (m) => console.log(m) });
  const session = await stt.openSession();
  console.log("STT session open (handshake ack received)");

  let speechEndAt: number | null = null;
  let finalText = "";
  let finalAt = 0;
  const TURN_END_SILENCE_MS = Number(process.env.TURN_END_SILENCE_MS ?? 1500);
  const done = (async () => {
    const iter = session.events()[Symbol.asyncIterator]();
    const parts: string[] = [];
    for (;;) {
      const nextP = iter.next();
      let result: IteratorResult<SttEvent>;
      if (parts.length === 0) {
        result = await nextP;
      } else {
        const raced = await Promise.race([nextP, sleep(TURN_END_SILENCE_MS).then(() => "silence" as const)]);
        if (raced === "silence") break;
        result = raced;
      }
      if (result.done) break;
      const e: SttEvent = result.value;
      if (e.type === "endpoint") speechEndAt = performance.now();
      if (e.type === "partial") console.log(`  partial: ${e.text}`);
      if (e.type === "error") throw new Error(e.message);
      if (e.type === "final" && e.text.trim()) {
        parts.push(e.text.trim());
        finalAt = performance.now();
      }
    }
    finalText = parts.join(" ");
  })();

  const FRAME = 3200; // 100 ms at 16 kHz PCM16
  const streamStart = performance.now();
  for (let off = 0; off < ownerPcm.length; off += FRAME) {
    session.push(new Uint8Array(ownerPcm.subarray(off, off + FRAME)));
    await sleep(100);
  }
  // 1.5 s of trailing silence so endpointing fires, then end the stream.
  const silence = new Uint8Array(FRAME);
  for (let i = 0; i < 15; i++) {
    session.push(silence);
    await sleep(100);
  }
  session.end();
  await Promise.race([
    done,
    sleep(30_000).then(() => {
      throw new Error("Timed out waiting for the final transcript");
    }),
  ]);
  session.close();
  void streamStart;
  const speechEndRef = speechEndAt ?? finalAt;
  console.log(`timing reference: ${speechEndAt !== null ? "endpoint (speechEnd) event" : "arrival of last final segment (no endpoint event seen)"}`);
  console.log(`transcript: ${JSON.stringify(finalText)}`);
  console.log(`timing speechEnd->final: ${Math.round(finalAt - speechEndRef)}ms`);
  if (!finalText) throw new Error("Empty transcript from STT; not calling the LLM");

  // 3) Real journalist prompt via Muse Spark.
  const brain = new JournalistBrain(new MetaLlm({ apiKey: modelKey }), await loadJournalistPrompts());
  const line = await brain.nextTurn(cafeScenario, [], finalText);
  const llmAt = performance.now();
  console.log(`reporter JSON: ${JSON.stringify(line)}`);
  console.log(`timing speechEnd->llm: ${Math.round(llmAt - speechEndRef)}ms`);

  // 4) Synthesize the reply at 24 kHz, streaming, and save it as WAV.
  let firstAudioAt: number | null = null;
  const replyChunks: Uint8Array[] = [];
  for await (const chunk of tts.synthesize(line.say)) {
    if (firstAudioAt === null) firstAudioAt = performance.now();
    replyChunks.push(chunk);
  }
  const replyPcm = Buffer.concat(replyChunks);
  console.log(`timing speechEnd->firstAudio: ${Math.round((firstAudioAt ?? llmAt) - speechEndRef)}ms`);
  console.log(`timing total speechEnd->voice: ${Math.round((firstAudioAt ?? llmAt) - speechEndRef)}ms`);

  const outDir = path.resolve(here, "../../tmp");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "smoke-reply.wav");
  await writeFile(outFile, Buffer.concat([wavHeader(replyPcm.length, 24000), replyPcm]));
  console.log(`reply audio: ${replyPcm.length} bytes PCM 24kHz (${(replyPcm.length / 48000).toFixed(1)}s) written to tmp/smoke-reply.wav`);
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
