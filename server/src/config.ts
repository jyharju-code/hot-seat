import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_HOST: z.string().min(1).default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  MODEL_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  ELEVENLABS_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SONIOX_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BASETEN_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  LLM_CHAT_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  LLM_STRUCTURED_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  TTS_PROVIDER: z.enum(["browser", "elevenlabs"]).default("browser"),
  TURN_LLM: z.enum(["meta", "baseten"]).default("meta"),
  TURN_RACE: z.enum(["on", "off"]).default("on"),
  HEDGE_AFTER_MS: z.coerce.number().int().nonnegative().max(60_000).default(1800),
  PARTIAL_STABLE_MS: z.coerce.number().int().positive().max(60_000).default(450),
  SCENARIO_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SCENARIO_REASONING: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  DATA_DIR: z.string().min(1).default("./data"),
  TURN_END_SILENCE_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  TURN_END_HESITANT_MS: z.coerce.number().int().positive().max(60_000).default(3200),
  LISTEN_IDLE_MS: z.coerce.number().int().positive().max(3_600_000).default(60_000),
  MAX_SESSION_MS: z.coerce.number().int().positive().max(3_600_000).default(720_000),
  INTERRUPTS: z.enum(["on", "off"]).default("on"),
  /** Calibrated ASR lag subtracted when mapping partials to audio (Brief 14). */
  ASR_LAG_MS: z.coerce.number().int().nonnegative().max(60_000).default(350),
});

export const BROWSER_TTS_LABEL = "Text to speech: browser speech synthesis (on-device, not a model call)";

export type Config = z.infer<typeof envSchema> & {
  /** Effective TTS provider after fallback. */
  ttsProvider: "browser" | "elevenlabs";
  ttsFallbackReason: string | null;
  dataDir: string;
  llmChatModel: string;
  llmStructuredModel: string;
  turnLlm: "meta" | "baseten";
  turnRace: boolean;
  partialStableMs: number;
  hedgeAfterMs: number;
  scenarioModel: string;
  scenarioReasoning: string;
  interruptsEnabled: boolean;
  asrLagMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const wantsEleven = parsed.data.TTS_PROVIDER === "elevenlabs";
  const ttsProvider: "browser" | "elevenlabs" = wantsEleven && parsed.data.ELEVENLABS_API_KEY ? "elevenlabs" : "browser";
  const ttsFallbackReason = wantsEleven && !parsed.data.ELEVENLABS_API_KEY
    ? "TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is missing; falling back to browser speech synthesis"
    : null;
  return {
    ...parsed.data,
    ttsProvider,
    ttsFallbackReason,
    dataDir: parsed.data.DATA_DIR,
    llmChatModel: parsed.data.LLM_CHAT_MODEL ?? "muse-spark-1.3",
    llmStructuredModel: parsed.data.LLM_STRUCTURED_MODEL ?? "muse-wonder-1.0",
    turnLlm: parsed.data.TURN_LLM,
    turnRace: parsed.data.TURN_RACE !== "off",
    partialStableMs: parsed.data.PARTIAL_STABLE_MS,
    hedgeAfterMs: parsed.data.HEDGE_AFTER_MS,
    scenarioModel: parsed.data.SCENARIO_MODEL ?? parsed.data.LLM_STRUCTURED_MODEL ?? "muse-wonder-1.0",
    scenarioReasoning: parsed.data.SCENARIO_REASONING ?? "medium",
    interruptsEnabled: parsed.data.INTERRUPTS !== "off",
    asrLagMs: parsed.data.ASR_LAG_MS,
  };
}

export function providerStatuses(config: Config) {
  const turnIsBaseten = config.turnLlm === "baseten";
  return [
    {
      id: "llm" as const,
      label: turnIsBaseten ? "Language model (turns: Baseten muse-spark-open, scenarios: Muse Wonder)" : "Language model (Muse Spark / Wonder)",
      adapter: turnIsBaseten ? "Baseten (turns) + Meta Model API (scenarios)" : "Meta Model API",
      configured: turnIsBaseten ? Boolean(config.BASETEN_API_KEY) : Boolean(config.MODEL_API_KEY),
    },
    { id: "speech-to-text" as const, label: "Speech to text (Muse Voice Transcribe)", adapter: "Meta Muse Voice Transcribe", configured: Boolean(config.MODEL_API_KEY) },
    config.ttsProvider === "browser"
      ? { id: "text-to-speech" as const, label: BROWSER_TTS_LABEL, adapter: "Browser speech synthesis", configured: true }
      : { id: "text-to-speech" as const, label: "Text to speech (ElevenLabs)", adapter: "ElevenLabs eleven_v4", configured: Boolean(config.ELEVENLABS_API_KEY) },
    { id: "image-gen" as const, label: "Image (Muse Image)", adapter: "Meta Muse Image", configured: Boolean(config.MODEL_API_KEY) },
  ];
}
