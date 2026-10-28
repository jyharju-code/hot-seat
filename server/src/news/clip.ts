import type { NewsTimelinePart } from "@hot-seat/shared";
import { pcmDurationMs } from "./soundbite.js";

export const CLIP_SAMPLE_RATE = 24000;
export const CLIP_SILENCE_MS = 400;
export const STUDIO_IMAGE_PROMPT =
  "a fictional local TV news studio anchor desk, evening, no people, no text, no logos";

export interface ClipPartInput {
  part: NewsTimelinePart["part"];
  text: string;
  pcm: Uint8Array;
}

/** Timeline with about 400 ms of silence between parts. */
export function buildTimeline(
  parts: ReadonlyArray<{ part: NewsTimelinePart["part"]; text: string; durationMs: number }>,
  silenceMs: number = CLIP_SILENCE_MS,
): NewsTimelinePart[] {
  const timeline: NewsTimelinePart[] = [];
  let cursor = 0;
  parts.forEach((p, i) => {
    if (i > 0) cursor += silenceMs;
    timeline.push({ part: p.part, startMs: cursor, endMs: cursor + p.durationMs, text: p.text });
    cursor += p.durationMs;
  });
  return timeline;
}

export function encodeWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, dataLen, true);
  out.set(pcm.subarray(0, dataLen), 44);
  return out;
}

/** Assemble intro + soundbite + outro at one rate into one WAV plus timeline. */
export function assembleClip(
  parts: readonly ClipPartInput[],
  sampleRate: number = CLIP_SAMPLE_RATE,
  silenceMs: number = CLIP_SILENCE_MS,
): { wav: Uint8Array; timeline: NewsTimelinePart[] } {
  const silenceBytes = Math.round((silenceMs / 1000) * sampleRate) * 2;
  const timeline = buildTimeline(
    parts.map((p) => ({ part: p.part, text: p.text, durationMs: pcmDurationMs(p.pcm.length, sampleRate) })),
    silenceMs,
  );
  const total = timeline.length ? timeline[timeline.length - 1]!.endMs : 0;
  const pcm = new Uint8Array(Math.round((total / 1000) * sampleRate) * 2);
  parts.forEach((p, i) => {
    const startByte = Math.round((timeline[i]!.startMs / 1000) * sampleRate) * 2;
    pcm.set(p.pcm.subarray(0, Math.max(0, pcm.length - startByte)), startByte);
    void silenceBytes;
  });
  return { wav: encodeWav(pcm, sampleRate), timeline };
}

/** Collect a TTS stream into one PCM buffer. */
export async function collectTts(
  tts: { synthesize: (text: string, options?: { voiceId?: string; model?: string; outputFormat?: "pcm_24000" | "pcm_16000"; signal?: AbortSignal }) => AsyncIterable<Uint8Array> },
  text: string,
  options?: { voiceId?: string; model?: string; outputFormat?: "pcm_24000" | "pcm_16000"; signal?: AbortSignal },
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of tts.synthesize(text, options)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
