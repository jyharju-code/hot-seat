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
import { BasetenLlm, ElevenLabsTextToSpeech, MetaLlm, MuseSpeechToText } from "./providers/index.js";
import { requireScenario, ScenarioStore, SCENARIO_EXPIRED_MESSAGE } from "./scenarios/store.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
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
      if (!config.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured on the server");
      const scenario = requireScenario(scenarioStore, scenarioId);
      const journalist = primaryJournalist(scenario);
      const prompts = await loadJournalistPrompts();
      let llm;
      let turnModel = config.llmChatModel;
      if (config.turnLlm === "baseten") {
        if (!config.BASETEN_API_KEY) throw new Error("BASETEN_API_KEY is not configured on the server");
        llm = new BasetenLlm({ apiKey: config.BASETEN_API_KEY });
        turnModel = "meta-models/muse-spark-open-1026";
      } else {
        llm = new MetaLlm({ apiKey: config.MODEL_API_KEY, chatModel: config.llmChatModel });
      }
      const record = sessionStore.startSession(scenario, Date.now(), scenarioId);
      const brain = new JournalistBrain(llm, prompts, turnModel);
      const interruptDecider = new LlmInterruptDecider(llm, await loadPrompt("interrupt-decision.md"), turnModel);
      const voice = voiceFor(journalist.temperament, journalist.voice);
      const orchestrator = new SessionOrchestrator({
        stt: new MuseSpeechToText({
          apiKey: config.MODEL_API_KEY,
          log: (m) => app.log.debug(m),
        }),
        brain,
        tts: new ElevenLabsTextToSpeech({ apiKey: config.ELEVENLABS_API_KEY, defaultVoiceId: voice.voiceId }),
        sink,
        scenario,
        record,
        interruptDecider,
        interruptsEnabled: config.interruptsEnabled,
        ...(escalationScale !== undefined ? { escalationScale } : {}),
        voiceId: voice.voiceId,
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
        log: (line) => app.log.info(line),
        debugLog: (line) => app.log.debug(line),
      });
      return { orchestrator, record };
    },
  });
});

await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(`Hot Seat server listening on http://${config.SERVER_HOST}:${config.SERVER_PORT}`);
