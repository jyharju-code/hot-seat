import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReporterLine, ServerMessage } from "@hot-seat/shared";
import { loadConfig } from "../src/config.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech, TextToSpeechOptions } from "../src/providers/text-to-speech.js";
import { cafeScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { SessionOrchestrator, type ClientSink } from "../src/session/orchestrator.js";
import { SessionStore } from "../src/session/store.js";

const OPENING: ReporterLine = { move: "new_angle", flags: [], say: "When did it break?", quote_used: null };
const tick = () => new Promise((r) => setTimeout(r, 0));
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

class FakeSession implements SttSession {
  pushed: Uint8Array[] = [];
  closed = false;
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(pcm: Uint8Array): void { this.pushed.push(pcm); }
  end(): void { /* noop */ }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>);
  }
  onPartial(): void { /* noop */ }
  emit(ev: SttEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    return { [Symbol.asyncIterator]: () => ({ next: (): Promise<IteratorResult<SttEvent>> => {
      const q = queue.shift();
      if (q) return Promise.resolve({ value: q, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true } as IteratorResult<SttEvent>);
      return new Promise((r) => waiters.push(r));
    } }) };
  }
}

class FakeStt implements SpeechToText {
  sessions: FakeSession[] = [];
  openCalls = 0;
  failOpens = 0;
  dieImmediately = false;
  async openSession(): Promise<SttSession> {
    this.openCalls += 1;
    if (this.failOpens > 0) { this.failOpens -= 1; throw new Error("open failed"); }
    const s = new FakeSession();
    this.sessions.push(s);
    if (this.dieImmediately) queueMicrotask(() => s.close());
    return s;
  }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> { yield { text: "", isFinal: true }; }
}

class FakeTts implements TextToSpeech {
  texts: string[] = [];
  options: TextToSpeechOptions[] = [];
  async *synthesize(text: string, options?: TextToSpeechOptions): AsyncIterable<Uint8Array> {
    this.texts.push(text);
    this.options.push(options ?? {});
    yield new Uint8Array([1, 0]);
  }
}

function makeSink() {
  const messages: ServerMessage[] = [];
  const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
  return { messages, sink };
}

function makeOrch(extra: Record<string, unknown> = {}) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const { messages, sink } = makeSink();
  const brain = {
    openingQuestion: async () => OPENING,
    nextTurn: async () => ({ move: "follow_up", flags: [], say: "Next?", quote_used: null }) as ReporterLine,
  };
  const orch = new SessionOrchestrator({
    stt, brain: brain as never, tts, sink, scenario: cafeScenario, voiceId: "v1", turnEndSilenceMs: 0, ...extra,
  } as never);
  return { stt, tts, messages, orch };
}

describe("config lifecycle defaults (brief 08 item 2)", () => {
  it("defaults LISTEN_IDLE_MS to 60000 and MAX_SESSION_MS to 600000, both overridable", () => {
    const c = loadConfig({});
    expect(c.LISTEN_IDLE_MS).toBe(60_000);
    expect(c.MAX_SESSION_MS).toBe(600_000);
    const c2 = loadConfig({ LISTEN_IDLE_MS: "5000", MAX_SESSION_MS: "9000" });
    expect(c2.LISTEN_IDLE_MS).toBe(5000);
    expect(c2.MAX_SESSION_MS).toBe(9000);
  });
});

describe("session ids (brief 08 item 8)", () => {
  it("two sessions for the same scenario get distinct ids and independent records", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hot-seat-sess-"));
    const store = new SessionStore(dir);
    const a = store.startSession(cafeTestScenario, 1000);
    const b = store.startSession(cafeTestScenario, 2000);
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    a.turns.push({ role: "user", text: "first run", elapsedSeconds: 1, flags: [] });
    expect(store.get(a.id)?.turns.map((t) => t.text)).toEqual(["first run"]);
    expect(store.get(b.id)?.turns).toEqual([]);
    expect(new SessionStore(dir).get(a.id)?.turns.map((t) => t.text)).toEqual(["first run"]);
  });
});

describe("idle and max session limits (brief 08 item 2)", () => {
  it("ends the session after LISTEN_IDLE_MS of listening with no speech", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, orch } = makeOrch({ listenIdleMs: 1000, maxSessionMs: 60_000 });
      await orch.start();
      await orch.playbackDone();
      await vi.advanceTimersByTimeAsync(999);
      expect(messages.some((m) => m.type === "ended")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toContainEqual({ type: "ended", message: "Session ended after a minute of silence." });
      expect(stt.sessions[0]!.closed).toBe(true);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("speech resets the idle clock", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, orch } = makeOrch({ listenIdleMs: 1000, maxSessionMs: 60_000 });
      await orch.start();
      await orch.playbackDone();
      await vi.advanceTimersByTimeAsync(600);
      stt.sessions[0]!.emit({ type: "partial", text: "We acted" });
      await vi.advanceTimersByTimeAsync(600);
      expect(messages.some((m) => m.type === "ended")).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(messages).toContainEqual({ type: "ended", message: "Session ended after a minute of silence." });
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("ends the session at MAX_SESSION_MS even if it is not listening", async () => {
    vi.useFakeTimers();
    try {
      const { messages, orch } = makeOrch({ listenIdleMs: 60_000, maxSessionMs: 2000 });
      await orch.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(messages.filter((m) => m.type === "ended")).toHaveLength(1);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });
});

describe("STT reconnect limits (brief 08 item 3)", () => {
  it("gives up after 3 consecutive open failures and surfaces one error", async () => {
    const { stt, messages, orch } = makeOrch({ sttBackoffMs: [1, 2, 4] });
    stt.failOpens = 10;
    await orch.start();
    await orch.playbackDone();
    await waitFor(() => messages.some((m) => m.type === "error"));
    expect(stt.openCalls).toBe(3);
    expect(messages.filter((m) => m.type === "error")).toHaveLength(1);
    await orch.stop();
  });

  it("a session that acks then dies repeatedly does not loop forever", async () => {
    const { stt, messages, orch } = makeOrch({ sttBackoffMs: [1, 2, 4] });
    stt.dieImmediately = true;
    await orch.start();
    await orch.playbackDone();
    await waitFor(() => messages.some((m) => m.type === "error"));
    expect(stt.openCalls).toBeLessThanOrEqual(4);
    expect(messages.filter((m) => m.type === "error")).toHaveLength(1);
    await orch.stop();
  });
});

describe("stop() cancels in-flight work (brief 08 item 4)", () => {
  it("aborts the signal given to the turn LLM and to TTS, and speaks nothing after stop", async () => {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, sink } = makeSink();
    let turnSignal: AbortSignal | undefined;
    let releaseTurn!: (line: ReporterLine) => void;
    const gate = new Promise<ReporterLine>((r) => { releaseTurn = r; });
    const brain = {
      openingQuestion: async () => OPENING,
      nextTurn: async (...args: unknown[]) => { turnSignal = args[4] as AbortSignal; return gate; },
    };
    const orch = new SessionOrchestrator({
      stt, brain: brain as never, tts, sink, scenario: cafeScenario, voiceId: "v1", turnEndSilenceMs: 0,
    });
    await orch.start();
    // Opening TTS received a signal.
    expect(tts.options[0]?.signal).toBeInstanceOf(AbortSignal);
    await orch.playbackDone();
    stt.sessions[0]!.emit({ type: "endpoint" });
    stt.sessions[0]!.emit({ type: "final", text: "We fixed it.", turnId: "t1" });
    await waitFor(() => turnSignal !== undefined);
    await orch.stop();
    expect(turnSignal!.aborted).toBe(true);
    expect(tts.options.every((o) => !o.signal || o.signal.aborted)).toBe(true);
    releaseTurn({ move: "follow_up", flags: [], say: "Too late?", quote_used: null });
    await tick(); await tick();
    expect(tts.texts).not.toContain("Too late?");
    expect(messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === "Too late?")).toBe(false);
  });
});
