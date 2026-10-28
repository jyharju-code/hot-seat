import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";
import tls from "node:tls";
import WebSocket from "ws";
import { NotImplementedError } from "./errors.js";
import { extractWordTimings } from "../news/soundbite.js";

/** Minimal HTTP CONNECT proxy agent so wss works behind HTTPS_PROXY (fetch honours it, ws does not). */
class ConnectProxyAgent extends https.Agent {
  constructor(private readonly proxy: URL) { super(); }
  override createConnection(options: http.RequestOptions, callback?: (err: Error | null, stream: import("node:stream").Duplex) => void): null {
    if (!callback) return null;
    const host = options.host ?? "localhost";
    const port = Number(options.port ?? 443);
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (this.proxy.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString("base64")}`;
    const req = http.request({ host: this.proxy.hostname, port: Number(this.proxy.port || 80), method: "CONNECT", path: `${host}:${port}`, headers });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); callback(new Error(`Proxy CONNECT failed: ${res.statusCode}`), socket); return; }
      const secure = tls.connect({ socket, servername: host, host, port });
      secure.once("secureConnect", () => callback(null, secure));
      secure.once("error", (err) => callback(err, secure));
    });
    req.once("error", (err) => callback(err, new Duplex({ read() { /* empty */ } })));
    req.end();
    return null;
  }
}

function proxyAgentFor(url: string): ConnectProxyAgent | undefined {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!raw || url.startsWith("ws://")) return undefined;
  try { return new ConnectProxyAgent(new URL(raw)); } catch { return undefined; }
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  startMs?: number;
  endMs?: number;
}

export interface SpeechToTextOptions {
  language?: "en" | "fi";
}

export interface SttWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export type SttEvent =
  | { type: "partial"; text: string; wordTimings?: SttWordTiming[] }
  | { type: "endpoint" }
  | { type: "final"; text: string; turnId?: string; wordTimings?: SttWordTiming[] }
  | { type: "error"; message: string };

/** One realtime STT session. push() PCM16 16 kHz frames, end() with endStream. */
export interface SttSession {
  push(pcm: Uint8Array): void;
  end(): void;
  close(): void;
  /** Async iterator of partial / endpoint / final / error events. */
  events(): AsyncIterable<SttEvent>;
  /** Convenience callback registration (partials feed the later interrupt feature). */
  onPartial(cb: (text: string) => void): void;
}

/** Streaming speech to text. First adapter: Meta Muse Voice Transcribe. */
export interface SpeechToText {
  openSession(options?: SpeechToTextOptions): Promise<SttSession>;
  transcribe(audio: AsyncIterable<Uint8Array>, options?: SpeechToTextOptions): AsyncIterable<TranscriptEvent>;
}

export class StubSpeechToText implements SpeechToText {
  async openSession(_options?: SpeechToTextOptions): Promise<SttSession> {
    throw new NotImplementedError("SpeechToText (Muse Voice Transcribe)");
  }
  async *transcribe(_audio: AsyncIterable<Uint8Array>, _options?: SpeechToTextOptions): AsyncIterable<TranscriptEvent> {
    throw new NotImplementedError("SpeechToText (Muse Voice Transcribe)");
    yield { text: "", isFinal: true }; // unreachable, keeps the generator shape explicit
  }
}

export interface MuseSttOptions {
  apiKey: string;
  url?: string;
  model?: string;
  /** Injectable for tests. */
  webSocketFactory?: (url: string) => WebSocket;
  log?: (msg: string) => void;
}

const DEFAULT_URL = "wss://api.meta.ai/v1/asr/realtime";

/** Muse Voice Transcribe realtime adapter (ENDPOINTING mode). */
export class MuseSpeechToText implements SpeechToText {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly factory: (url: string) => WebSocket;
  private readonly log: (msg: string) => void;

  constructor(options: MuseSttOptions) {
    if (!options.apiKey) throw new Error("MuseSpeechToText requires an apiKey (MODEL_API_KEY)");
    this.apiKey = options.apiKey;
    this.url = options.url ?? DEFAULT_URL;
    this.model = options.model ?? "muse-voice-transcribe-1.0";
    this.factory = options.webSocketFactory ?? ((url) => { const agent = proxyAgentFor(url); return agent ? new WebSocket(url, { agent }) : new WebSocket(url); });
    this.log = options.log ?? (() => undefined);
  }

  async openSession(_options?: SpeechToTextOptions): Promise<SttSession> {
    const ws = this.factory(this.url);
    const session = new MuseSttSession(ws, this.log);
    await session.handshake({
      mode: "ENDPOINTING",
      authorization: { accessToken: this.apiKey },
      audioEncoding: "PCM_16KHZ",
      model: this.model,
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
      languageBias: ["English"],
    });
    return session;
  }

  async *transcribe(audio: AsyncIterable<Uint8Array>, options?: SpeechToTextOptions): AsyncIterable<TranscriptEvent> {
    const session = await this.openSession(options);
    void (async () => {
      try {
        for await (const chunk of audio) session.push(chunk);
      } finally {
        session.end();
      }
    })();
    for await (const ev of session.events()) {
      if (ev.type === "partial") yield { text: ev.text, isFinal: false };
      else if (ev.type === "final") yield { text: ev.text, isFinal: true };
      else if (ev.type === "error") throw new Error(ev.message);
    }
  }
}

class MuseSttSession implements SttSession {
  private readonly ws: WebSocket;
  private readonly log: (msg: string) => void;
  private readonly queue: SttEvent[] = [];
  private readonly waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  private readonly partialCbs: Array<(text: string) => void> = [];
  private readonly seenTypes = new Set<string>();
  private done = false;
  private ended = false;

  constructor(ws: WebSocket, log: (msg: string) => void) {
    this.ws = ws;
    this.log = log;
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      this.handleText(data.toString());
    });
    ws.on("error", (err: Error) => this.emit({ type: "error", message: `STT socket error: ${err.message}` }));
    ws.on("close", () => {
      this.done = true;
      this.flushWaiters();
    });
  }

  async handshake(payload: Record<string, unknown>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const closeSocket = () => {
        try {
          this.ws.close();
        } catch {
          /* already closed */
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        closeSocket();
        reject(new Error("STT handshake timed out waiting for ack"));
      }, 20_000);
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off("message", onMsg);
        this.ws.off("error", onErr);
        this.ws.off("close", onClose);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("STT socket closed before handshake ack"));
      };
      const onErr = (err: Error) => {
        cleanup();
        closeSocket();
        reject(err);
      };
      const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let parsed: { type?: string; message?: string };
        try {
          parsed = JSON.parse(data.toString()) as { type?: string; message?: string };
        } catch {
          return;
        }
        if (parsed.type === "error") {
          cleanup();
          closeSocket();
          reject(new Error(`Muse Voice Transcribe error: ${parsed.message ?? "unknown error"}`));
          return;
        }
        // Any non-error first message counts as the ack. Re-dispatch it so
        // a speech event that raced the ack is not lost.
        cleanup();
        this.handleText(data.toString());
        resolve();
      };
      this.ws.on("message", onMsg);
      this.ws.on("error", onErr);
      this.ws.on("close", onClose);
      const send = () => this.ws.send(JSON.stringify(payload));
      if (this.ws.readyState === WebSocket.OPEN) send();
      else this.ws.once("open", send);
    });
  }

  push(pcm: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm, { binary: true });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "endStream" }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.done = true;
    this.flushWaiters();
  }

  onPartial(cb: (text: string) => void): void {
    this.partialCbs.push(cb);
  }

  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    const isDone = () => this.done;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SttEvent> {
        return {
          next(): Promise<IteratorResult<SttEvent>> {
            const queued = queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (isDone()) return Promise.resolve({ value: undefined, done: true } as IteratorResult<SttEvent>);
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    };
  }

  private handleText(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof msg.type === "string" ? msg.type : "";
    if (!this.seenTypes.has(type)) {
      this.seenTypes.add(type);
      this.log(`[stt] event type: ${type || "(missing)"} ${safePreview(msg)}`);
    }
    if (type === "error") {
      this.emit({ type: "error", message: String(msg.message ?? "Muse Voice Transcribe error") });
      return;
    }
    if (type === "speechEnd") {
      this.emit({ type: "endpoint" });
      return;
    }
    if (type === "speechComplete") {
      const transcript = typeof msg.transcript === "string" ? msg.transcript : "";
      const turnId = typeof msg.turnId === "string" ? msg.turnId : undefined;
      const wordTimings = extractWordTimings(msg) ?? undefined;
      this.emit({
        type: "final",
        text: transcript,
        ...(turnId ? { turnId } : {}),
        ...(wordTimings ? { wordTimings } : {}),
      });
      return;
    }
    // Partial transcripts: shape is not fully documented, accept common fields.
    const partialText =
      typeof msg.transcript === "string"
        ? msg.transcript
        : typeof msg.text === "string"
          ? msg.text
          : typeof msg.partial === "string"
            ? msg.partial
            : undefined;
    if (partialText !== undefined && /partial|transcript|speech/i.test(type)) {
      for (const cb of this.partialCbs) cb(partialText);
      const wordTimings = extractWordTimings(msg) ?? undefined;
      this.emit(wordTimings ? { type: "partial", text: partialText, wordTimings } : { type: "partial", text: partialText });
      return;
    }
  }

  private emit(ev: SttEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: ev, done: false });
    else this.queue.push(ev);
  }

  private flushWaiters(): void {
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined, done: true } as IteratorResult<SttEvent>);
    }
  }
}

function safePreview(msg: Record<string, unknown>): string {
  try {
    return JSON.stringify(msg).slice(0, 200);
  } catch {
    return "";
  }
}
