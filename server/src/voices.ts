import type { Temperament, VoiceGender } from "@hot-seat/shared";

/** TTS voices keyed by reporter temperament and voice gender. Config, not code paths. */
export interface VoiceConfig {
  name: string;
  voiceId: string;
}

export const voices = {
  relentless: {
    male: { name: "Walter", voiceId: "9ZbFvrGBxO3uSmsw6wdI" },
    female: { name: "Sarah", voiceId: "EXAVITQu4vr4xnSDxMaL" },
  },
  precise: {
    male: { name: "Jo", voiceId: "NLRQGWzZAJhAXSlAr34B" },
    female: { name: "Alice", voiceId: "Xb7hH8MSUJpSbSDYk0k2" },
  },
  human: {
    male: { name: "Liam", voiceId: "TX3LPaxmHKxFdv7VOQHJ" },
    female: { name: "Matilda", voiceId: "XrExE9yKIg1WjnnlVkGX" },
  },
} as const satisfies Record<Temperament, Record<VoiceGender, VoiceConfig>>;

export type VoiceRole = keyof typeof voices;

/** Resolve a voice. Missing voice (old fixtures) defaults to male. */
export function voiceFor(temperament: Temperament, voice: VoiceGender | undefined = "male"): VoiceConfig {
  return voices[temperament][voice ?? "male"];
}
