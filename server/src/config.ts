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
  TURN_END_SILENCE_MS: z.coerce.number().int().positive().max(60_000).default(1400),
  TURN_END_HESITANT_MS: z.coerce.number().int().positive().max(60_000).default(3200),
  LISTEN_IDLE_MS: z.coerce.number().int().positive().max(3_600_000).default(60_000),
  MAX_SESSION_MS: z.coerce.number().int().positive().max(3_600_000).default(720_000),
  INTERRUPTS: z.enum(["on", "off"]).default("on"),
  /** Calibrated ASR lag subtracted when mapping partials to audio (Brief 14). */
  ASR_LAG_MS: z.coerce.number().int().nonnegative().max(60_000).default(350),
  TURN_LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(8_000),
  SCENARIO_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  DEBRIEF_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(90_000),
  IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(90_000),
  NEWS_TTS_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(30_000),
  STT_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(20_000),
  DEV_TURN_LOG: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).optional()),
  /** Public gate code. Unset means no gate (local dev, sims). Never logged. */
  ACCESS_CODE: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** Server-wide scenario generations per day. Unset or 0 means no cap. */
  MAX_SESSIONS_PER_DAY: z.coerce.number().int().nonnegative().max(10_000).default(60),
  /** Scenario generations per client IP per hour. Unset or 0 means no cap. */
  MAX_SESSIONS_PER_IP_PER_HOUR: z.coerce.number().int().nonnegative().max(10_000).default(6),
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
  turnLlmTimeoutMs: number;
  scenarioTimeoutMs: number;
  debriefTimeoutMs: number;
  imageTimeoutMs: number;
  newsTtsTimeoutMs: number;
  sttHandshakeTimeoutMs: number;
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
    turnLlmTimeoutMs: parsed.data.TURN_LLM_TIMEOUT_MS,
    scenarioTimeoutMs: parsed.data.SCENARIO_TIMEOUT_MS,
    debriefTimeoutMs: parsed.data.DEBRIEF_TIMEOUT_MS,
    imageTimeoutMs: parsed.data.IMAGE_TIMEOUT_MS,
    newsTtsTimeoutMs: parsed.data.NEWS_TTS_TIMEOUT_MS,
    sttHandshakeTimeoutMs: parsed.data.STT_HANDSHAKE_TIMEOUT_MS,
  };
}

/**
 * Effective listen address. Render sets PORT: when it holds a valid port it
 * wins over SERVER_PORT and the host becomes 0.0.0.0. Otherwise the local
 * SERVER_HOST/SERVER_PORT defaults apply, so local dev is unchanged.
 */
export function resolveListen(
  env: NodeJS.ProcessEnv = process.env,
  config: Pick<Config, "SERVER_HOST" | "SERVER_PORT">,
): { host: string; port: number } {
  const raw = env.PORT;
  const port = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return { host: "0.0.0.0", port };
  }
  return { host: config.SERVER_HOST, port: config.SERVER_PORT };
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
