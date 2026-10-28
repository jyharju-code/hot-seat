import type { TextToSpeech } from "../../src/providers/text-to-speech.js";
import type { OwnerSegment } from "./owner.js";
import { pcmDurationMs, silenceBytes, type SegmentTiming } from "./pacing.js";

/** One stable owner voice per session. Either is fine per the brief. */
export const OWNER_VOICES = {
  male: "TX3LPaxmHKxFdv7VOQHJ",
  female: "XrExE9yKIg1WjnnlVkGX",
} as const;

export type OwnerVoiceGender = keyof typeof OWNER_VOICES;

export const OWNER_TTS_MODEL = "eleven_flash_v2_5";

export interface VoicedAnswer {
  /** Speech and pause silence concatenated, PCM16 16 kHz, ready to frame. */
  pcm: Buffer;
  /** Per-segment timings for the pacing plan. */
  timings: SegmentTiming[];
  /** Bytes of real speech (excludes the final segment's trailing pause). */
  speechBytes: number;
  chars: number;
}

/** Synthesise each segment with eleven_flash_v2_5 pcm_16000 and insert pause silence. */
export async function synthesizeAnswer(
  tts: TextToSpeech,
  segments: readonly OwnerSegment[],
  voiceId: string,
): Promise<VoicedAnswer> {
  const parts: Buffer[] = [];
  const timings: SegmentTiming[] = [];
  let speechBytes = 0;
  let chars = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    chars += segment.text.length;
    const chunks: Uint8Array[] = [];
    for await (const chunk of tts.synthesize(segment.text, {
      voiceId,
      model: OWNER_TTS_MODEL,
      outputFormat: "pcm_16000",
    })) {
      chunks.push(chunk);
    }
    const audio = Buffer.concat(chunks);
    const silence = Buffer.alloc(silenceBytes(segment.pause_after_ms));
    parts.push(audio, silence);
    timings.push({ durationMs: pcmDurationMs(audio.length), pauseAfterMs: segment.pause_after_ms });
    speechBytes += audio.length + (i < segments.length - 1 ? silence.length : 0);
  }
  return { pcm: Buffer.concat(parts), timings, speechBytes, chars };
}
