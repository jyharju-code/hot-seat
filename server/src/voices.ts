/** TTS voices keyed by reporter temperament. Config, not code paths. */
export interface VoiceConfig {
  name: string;
  voiceId: string;
}

export const voices = {
  relentless: { name: "Walter", voiceId: "9ZbFvrGBxO3uSmsw6wdI" },
  precise: { name: "Jo", voiceId: "NLRQGWzZAJhAXSlAr34B" },
  human: { name: "Liam", voiceId: "TX3LPaxmHKxFdv7VOQHJ" },
} as const satisfies Record<string, VoiceConfig>;

export type VoiceRole = keyof typeof voices;
