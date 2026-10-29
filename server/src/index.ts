import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";

loadDotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
loadDotenv();
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JournalistBrain, loadJournalistPrompts, primaryJournalist } from "./journalist.js";
import { LlmInterruptDecider } from "./interrupt.js";
import { loadPrompt } from "./prompts.js";
import { BASETEN_DEFAULT_MODEL, BasetenLlm, ElevenLabsTextToSpeech, HedgedLlm, MetaLlm, MuseSpeechToText, StubTextToSpeech, type HedgedProvider, type Llm } from "./providers/index.js";
import { BROWSER_TTS_LABEL } from "./config.js";
import { requireScenario, ScenarioStore, SCENARIO_EXPIRED_MESSAGE } from "./scenarios/store.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { generateInterviewPlan } from "./session/interview-plan.js";
import { appendFileSync, mkdirSync } from "node:fs";
import nodePath from "node:path";
import { SessionStore } from "./session/store.js";
import { voiceFor } from "./voices.js";
import { attachSessionSocket } from "./ws-session.js";

const config = loadConfig();
const scenarioStore = new ScenarioStore(config.dataDir);
const sessionStore = new SessionStore(config.dataDir);
const app = buildApp(config, { store: scenarioStore, sessions: sessionStore });

console.log(
  `[config] MODEL_API_KEY ${config.MODEL_API_KEY ? "present" : "missing"}, ` +
    `ELEVENLABS_API_KEY ${config.ELEVENLABS_API_KEY ? "present" : "missing"}, ` +
    `SONIOX_API_KEY ${config.SONIOX_API_KEY ? "present" : "missing"}, ` +
    `BASETEN_API_KEY ${config.BASETEN_API_KEY ? "present" : "missing"}`,
);
if (config.ttsFallbackReason) console.log(`[config] ${config.ttsFallbackReason}`);
console.log(`[config] ${config.ttsProvider === "browser" ? BROWSER_TTS_LABEL : "Text to speech: ElevenLabs eleven_v4"}`);

const wss = new WebSocketServer({ noServer: true });
app.server.on("upgrade", (request, socket, head) => {
  if (request.url === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket) => {
  attachSessionSocket(ws, {
    persist: (record) => sessionStore.put(record),
    formatError: (err) => {
      const raw = err instanceof Error ? err.message : String(err);
      return raw.startsWith("Unknown scenarioId") ? SCENARIO_EXPIRED_MESSAGE : raw;
    },
    build: async (scenarioId, escalationScaleRaw, sink) => {
      const escalationScale = config.NODE_ENV !== "production" ? escalationScaleRaw : undefined;
      if (!config.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not configured on the server");
      if (config.ttsProvider === "elevenlabs" && !config.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured on the server");
      const scenario = requireScenario(scenarioStore, scenarioId);
      const journalist = primaryJournalist(scenario);
      const prompts = await loadJournalistPrompts();
      let primaryLlm: Llm;
      let primaryProvider: HedgedProvider;
      let turnModel = config.llmChatModel;
      if (config.turnLlm === "baseten") {
        if (!config.BASETEN_API_KEY) throw new Error("BASETEN_API_KEY is not configured on the server");
        primaryLlm = new BasetenLlm({ apiKey: config.BASETEN_API_KEY, chatTimeoutMs: config.turnLlmTimeoutMs });
        turnModel = BASETEN_DEFAULT_MODEL;
        primaryProvider = { name: "baseten", llm: primaryLlm, model: turnModel };
      } else {
        primaryLlm = new MetaLlm({ apiKey: config.MODEL_API_KEY, chatModel: config.llmChatModel, chatTimeoutMs: config.turnLlmTimeoutMs, structuredTimeoutMs: config.debriefTimeoutMs });
        primaryProvider = { name: "meta", llm: primaryLlm, model: turnModel };
      }
      // Hedge turn calls on the other provider only when both keys exist.
      let hedgeProvider: HedgedProvider | null = null;
      if (config.MODEL_API_KEY && config.BASETEN_API_KEY) {
        hedgeProvider =
          primaryProvider.name === "meta"
            ? { name: "baseten", llm: new BasetenLlm({ apiKey: config.BASETEN_API_KEY, chatTimeoutMs: config.turnLlmTimeoutMs }), model: BASETEN_DEFAULT_MODEL }
            : { name: "meta", llm: new MetaLlm({ apiKey: config.MODEL_API_KEY, chatModel: config.llmChatModel, chatTimeoutMs: config.turnLlmTimeoutMs, structuredTimeoutMs: config.debriefTimeoutMs }), model: config.llmChatModel };
      }
      const llm: Llm = new HedgedLlm({
        primary: primaryProvider,
        hedge: hedgeProvider,
        hedgeAfterMs: config.hedgeAfterMs,
        mode: config.turnRace ? "race" : "hedge",
        log: (line) => app.log.info(line),
      });
      const record = sessionStore.startSession(scenario, Date.now(), scenarioId);
      const planLlm = new MetaLlm({ apiKey: config.MODEL_API_KEY, chatModel: config.llmChatModel, chatTimeoutMs: 20_000, structuredTimeoutMs: 20_000 });
      const devTurnLog = process.env.DEV_TURN_LOG === "1"
        ? (entry: unknown) => { try { const dir = nodePath.join(config.dataDir, "dev"); mkdirSync(dir, { recursive: true }); appendFileSync(nodePath.join(dir, `turns-${record.id}.jsonl`), `${JSON.stringify(entry)}\n`); } catch { /* best effort */ } }
        : undefined;
      const brain = new JournalistBrain(llm, prompts, turnModel, (line) => app.log.info(line));
      const interruptDecider = new LlmInterruptDecider(llm, await loadPrompt("interrupt-decision.md"), turnModel);
      const voice = voiceFor(journalist.temperament, journalist.voice);
      const orchestrator = new SessionOrchestrator({
        stt: new MuseSpeechToText({
          apiKey: config.MODEL_API_KEY,
          log: (m) => app.log.debug(m),
          handshakeTimeoutMs: config.sttHandshakeTimeoutMs,
        }),
        brain,
        tts: config.ttsProvider === "elevenlabs" && config.ELEVENLABS_API_KEY ? new ElevenLabsTextToSpeech({ apiKey: config.ELEVENLABS_API_KEY, defaultVoiceId: voice.voiceId, timeoutMs: config.newsTtsTimeoutMs }) : new StubTextToSpeech(),
        ttsProvider: config.ttsProvider,
        sink,
        scenario,
        record,
        interruptDecider,
        interruptsEnabled: scenario.format === "profile" ? false : config.interruptsEnabled,
        ...(escalationScale !== undefined ? { escalationScale } : {}),
        voiceId: voice.voiceId,
        partialStableMs: config.partialStableMs,
        asrLagMs: config.asrLagMs,
        turnEndSilenceMs: config.TURN_END_SILENCE_MS,
        turnEndHesitantMs: config.TURN_END_HESITANT_MS,
        listenIdleMs: config.LISTEN_IDLE_MS,
        maxSessionMs: config.MAX_SESSION_MS,
        onSessionEnded: () => {
          try {
            sessionStore.put(record);
          } catch {
            /* best effort */
          }
        },
        interviewPlanProvider: () => generateInterviewPlan(planLlm, scenario, { model: config.llmStructuredModel, ...(prompts.interviewPlan ? { promptTemplate: prompts.interviewPlan } : {}) }),
        ...(devTurnLog ? { devTurnLog } : {}),
        log: (line) => app.log.info(line),
        errorLog: (line) => app.log.error(line),
        debugLog: (line) => app.log.debug(line),
      });
      return { orchestrator, record };
    },
  });
});

await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(`Hot Seat server listening on http://${config.SERVER_HOST}:${config.SERVER_PORT}`);
