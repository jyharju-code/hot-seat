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
  TURN_LLM: z.enum(["meta", "baseten"]).default("meta"),
  SCENARIO_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SCENARIO_REASONING: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  DATA_DIR: z.string().min(1).default("./data"),
  TURN_END_SILENCE_MS: z.coerce.number().int().positive().max(60_000).default(1500),
  LISTEN_IDLE_MS: z.coerce.number().int().positive().max(3_600_000).default(60_000),
  MAX_SESSION_MS: z.coerce.number().int().positive().max(3_600_000).default(600_000),
  INTERRUPTS: z.enum(["on", "off"]).default("on"),
});

export type Config = z.infer<typeof envSchema> & {
  dataDir: string;
  llmChatModel: string;
  llmStructuredModel: string;
  turnLlm: "meta" | "baseten";
  scenarioModel: string;
  scenarioReasoning: string;
  interruptsEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return {
    ...parsed.data,
    dataDir: parsed.data.DATA_DIR,
    llmChatModel: parsed.data.LLM_CHAT_MODEL ?? "muse-spark-1.3",
    llmStructuredModel: parsed.data.LLM_STRUCTURED_MODEL ?? "muse-wonder-1.0",
    turnLlm: parsed.data.TURN_LLM,
    scenarioModel: parsed.data.SCENARIO_MODEL ?? parsed.data.LLM_STRUCTURED_MODEL ?? "muse-wonder-1.0",
    scenarioReasoning: parsed.data.SCENARIO_REASONING ?? "medium",
    interruptsEnabled: parsed.data.INTERRUPTS !== "off",
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
    { id: "text-to-speech" as const, label: "Text to speech (ElevenLabs)", adapter: "ElevenLabs eleven_v4", configured: Boolean(config.ELEVENLABS_API_KEY) },
    { id: "image-gen" as const, label: "Image (Muse Image)", adapter: "Meta Muse Image", configured: Boolean(config.MODEL_API_KEY) },
  ];
}
