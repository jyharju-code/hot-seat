/** TTS voices keyed by reporter temperament role. Config, not code paths. */
export interface VoiceConfig {
  name: string;
  voiceId: string;
}

export const voices = {
  relentless: { name: "Walter", voiceId: "9ZbFvrGBxO3uSmsw6wdI" },
} as const satisfies Record<string, VoiceConfig>;

export type VoiceRole = keyof typeof voices;
