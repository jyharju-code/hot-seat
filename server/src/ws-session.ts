import type { WebSocket } from "ws";
import { clientMessageSchema, type ServerMessage } from "@hot-seat/shared";
import type { SessionRecord } from "./session/store.js";

/** The slice of SessionOrchestrator the socket handler drives. */
export interface OrchestratorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  playbackDone(): Promise<void>;
  speechStarted?(speechStartMs?: number): void;
  pushAudio(pcm: Uint8Array): void;
}

export interface BuiltSession {
  orchestrator: OrchestratorLike;
  record: SessionRecord;
}

export interface SessionSocketDeps {
  /** Build (but do not start) a session for a scenario. Throws on bad input. */
  build: (
    scenarioId: string,
    escalationScale: number | undefined,
    sink: { send: (message: ServerMessage) => void; sendAudio: (chunk: Uint8Array) => void },
  ) => Promise<BuiltSession>;
  persist: (record: SessionRecord) => void;
  formatError?: (err: unknown) => string;
}

export type SessionSocket = Pick<WebSocket, "on" | "send" | "readyState" | "OPEN">;

/**
 * One browser socket. A second `start` stops the previous orchestrator
 * before replacing it, and a disconnect during the start awaits never
 * leaves an orphan session running with no client.
 */
export function attachSessionSocket(ws: SessionSocket, deps: SessionSocketDeps): void {
  let orchestrator: OrchestratorLike | null = null;
  let currentRecord: SessionRecord | null = null;
  let closed = false;
  let startSeq = 0;

  const persistFinished = () => {
    if (!currentRecord) return;
    try {
      deps.persist(currentRecord);
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
      const escalationScale = msg.data.escalationScale;
      const seq = ++startSeq;
      void (async () => {
        // Stop any existing session first: its STT socket and timers die here.
        const previous = orchestrator;
        orchestrator = null;
        if (previous) await previous.stop();
        if (closed || seq !== startSeq) return;
        try {
          const built = await deps.build(scenarioId, escalationScale, {
            send: (message) => sendJson(message),
            sendAudio: (chunk) => {
              if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
            },
          });
          if (closed || seq !== startSeq) {
            // Disconnected (or superseded) while building: never start it.
            await built.orchestrator.stop();
            return;
          }
          orchestrator = built.orchestrator;
          currentRecord = built.record;
          sendJson({ type: "session_started", sessionId: built.record.id });
          await built.orchestrator.start();
          if (closed || seq !== startSeq) {
            if (orchestrator === built.orchestrator) orchestrator = null;
            await built.orchestrator.stop();
          }
        } catch (err) {
          if (closed) return;
          const message = deps.formatError
            ? deps.formatError(err)
            : err instanceof Error
              ? err.message
              : String(err);
          sendJson({ type: "error", message });
        }
      })();
    } else if (msg.data.type === "playback_done") {
      void orchestrator?.playbackDone();
    } else if (msg.data.type === "speech_started") {
      orchestrator?.speechStarted?.(msg.data.speechStartMs);
    } else if (msg.data.type === "stop") {
      startSeq += 1;
      const current = orchestrator;
      orchestrator = null;
      void current?.stop();
      persistFinished();
    }
  });

  ws.on("close", () => {
    closed = true;
    startSeq += 1;
    const current = orchestrator;
    orchestrator = null;
    void current?.stop();
    persistFinished();
  });
}
