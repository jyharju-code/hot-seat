import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";

loadDotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
loadDotenv();
import { clientMessageSchema } from "@hot-seat/shared";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JournalistBrain, loadJournalistPrompts } from "./journalist.js";
import { ElevenLabsTextToSpeech, MetaLlm, MuseSpeechToText } from "./providers/index.js";
import { cafeScenario } from "./scenarios/cafe.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { voices } from "./voices.js";

const config = loadConfig();
const app = buildApp(config);

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
      void (async () => {
        try {
          if (!config.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not configured on the server");
          if (!config.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured on the server");
          const prompts = await loadJournalistPrompts();
          const llm = new MetaLlm({ apiKey: config.MODEL_API_KEY, chatModel: config.llmChatModel });
          const brain = new JournalistBrain(llm, prompts, config.llmChatModel);
          const voice = voices[cafeScenario.reporter.voiceRole];
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
            scenario: cafeScenario,
            voiceId: voice.voiceId,
            turnEndSilenceMs: config.TURN_END_SILENCE_MS,
            log: (line) => app.log.info(line),
          });
          await orchestrator.start();
        } catch (err) {
          sendJson({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      })();
    } else if (msg.data.type === "stop") {
      void orchestrator?.stop();
      orchestrator = null;
    }
  });

  ws.on("close", () => {
    void orchestrator?.stop();
    orchestrator = null;
  });
});

await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
app.log.info(`Hot Seat server listening on http://${config.SERVER_HOST}:${config.SERVER_PORT}`);
