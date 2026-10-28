import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";

loadDotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
loadDotenv();
import { clientMessageSchema } from "@hot-seat/shared";
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
  let orchestrator: SessionOrchestrator | null = null;
  let currentRecord: ReturnType<typeof sessionStore.start> | null = null;
  const persistFinished = () => {
    if (!currentRecord) return;
    try {
      sessionStore.put(currentRecord);
    } catch {
      /* best effort */
    }
  };

  const sendJson = (value: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      orchestrator?.pushAudio(new Uint8Array(data));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      sendJson({ type: "error", message: "Invalid JSON message" });
      return;
    }
    const msg = clientMessageSchema.safeParse(parsed);
    if (!msg.success) {
      sendJson({ type: "error", message: "Unknown client message" });
      return;
    }
    if (msg.data.type === "start") {
      const scenarioId = msg.data.scenarioId;
      const escalationScale = config.NODE_ENV !== "production" ? msg.data.escalationScale : undefined;
      void (async () => {
        try {
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
          const record = sessionStore.start(scenarioId, scenario, Date.now());
          currentRecord = record;
          const brain = new JournalistBrain(llm, prompts, turnModel);
          const interruptDecider = new LlmInterruptDecider(llm, await loadPrompt("interrupt-decision.md"), turnModel);
          const voice = voiceFor(journalist.temperament, journalist.voice);
          orchestrator = new SessionOrchestrator({
            stt: new MuseSpeechToText({
              apiKey: config.MODEL_API_KEY,
              log: (m) => app.log.debug(m),
            }),
            brain,
            tts: new ElevenLabsTextToSpeech({ apiKey: config.ELEVENLABS_API_KEY, defaultVoiceId: voice.voiceId }),
            sink: {
              send: (message) => sendJson(message),
              sendAudio: (chunk) => {
                if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
              },
            },
            scenario,
            record,
            interruptDecider,
            interruptsEnabled: config.interruptsEnabled,
            ...(escalationScale !== undefined ? { escalationScale } : {}),
            voiceId: voice.voiceId,
            turnEndSilenceMs: config.TURN_END_SILENCE_MS,
            log: (line) => app.log.info(line),
          });
          await orchestrator.start();
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const message = raw.startsWith("Unknown scenarioId") ? SCENARIO_EXPIRED_MESSAGE : raw;
          sendJson({ type: "error", message });
        }
      })();
    } else if (msg.data.type === "playback_done") {
      void orchestrator?.playbackDone();
    } else if (msg.data.type === "stop") {
      void orchestrator?.stop();
      orchestrator = null;
      persistFinished();
    }
  });

  ws.on("close", () => {
    void orchestrator?.stop();
    orchestrator = null;
    persistFinished();
  });
});

await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(`Hot Seat server listening on http://${config.SERVER_HOST}:${config.SERVER_PORT}`);
