import { describe, expect, it, vi } from "vitest";
import type { ReporterLine, ServerMessage } from "@hot-seat/shared";
import { JournalistBrain, parseReporterLine, type JournalistPrompts } from "../src/journalist.js";
import type { Llm, LlmChatResult } from "../src/providers/llm.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";
import { cafeScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { SessionOrchestrator, type ClientSink } from "../src/session/orchestrator.js";
import { formatEvents, type SessionRecord } from "../src/session/store.js";

const VALID = JSON.stringify({
  move: "follow_up",
  flags: ["dodge"],
  say: "[sharply] That is not what I asked. When did you know?",
  quote_used: null,
});
const OPENING: ReporterLine = {
  move: "new_angle",
  flags: [],
  say: "[impatient] Walter, Riverside Courier. When did the display case break?",
  quote_used: null,
};
const PROMPTS: JournalistPrompts = {
  spokenStyle: "STYLE",
  journalistTurn: "T {last_answer} facts:{public_facts} mines:{landmines_known_to_you} {spoken_style}",
  openingQuestion: "O",
};

class FakeLlm implements Llm {
  calls = 0;
  lastMaxTokens = 0;
  lastReasoning: string | undefined;
  lastPrompt = "";
  constructor(private readonly replies: string[]) {}
  async chat(input: { maxTokens?: number; reasoningEffort?: string; messages?: Array<{ content: string }> }): Promise<LlmChatResult> {
    this.lastMaxTokens = input.maxTokens ?? 0;
    this.lastReasoning = input.reasoningEffort;
    this.lastPrompt = input.messages?.[0]?.content ?? "";
    const text = this.replies[Math.min(this.calls, this.replies.length - 1)]!;
    this.calls += 1;
    return { text, model: "muse-spark-1.3", finishReason: "stop" };
  }
  async generateStructured<T>(): Promise<T> {
    throw new Error("not used");
  }
}

class FakeSession implements SttSession {
  pushed: Uint8Array[] = [];
  ended = false;
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(pcm: Uint8Array): void {
    this.pushed.push(pcm);
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    /* noop */
  }
  onPartial(_cb: (t: string) => void): void {
    /* noop */
  }
  emit(ev: SttEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    return {
      [Symbol.asyncIterator]: () => ({
        next(): Promise<IteratorResult<SttEvent>> {
          const q = queue.shift();
          if (q) return Promise.resolve({ value: q, done: false });
          return new Promise((r) => waiters.push(r));
        },
      }),
    };
  }
}

class FakeStt implements SpeechToText {
  sessions: FakeSession[] = [];
  async openSession(): Promise<SttSession> {
    const s = new FakeSession();
    this.sessions.push(s);
    return s;
  }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> {
    yield { text: "", isFinal: true };
  }
}

class FakeTts implements TextToSpeech {
  texts: string[] = [];
  options: Array<{ voiceId?: string; model?: string }> = [];
  async *synthesize(text: string, options?: { voiceId?: string; model?: string }): AsyncIterable<Uint8Array> {
    this.texts.push(text);
    this.options.push(options ?? {});
    yield new Uint8Array([1, 0, 2, 0]);
    yield new Uint8Array([3, 0]);
  }
}

function makeSink() {
  const messages: ServerMessage[] = [];
  const audio: Uint8Array[] = [];
  const sink: ClientSink = {
    send: (m) => messages.push(m),
    sendAudio: (c) => audio.push(c),
  };
  return { messages, audio, sink };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("JournalistBrain", () => {
  it("parses valid reporter JSON and rejects invalid", () => {
    expect(parseReporterLine(VALID).move).toBe("follow_up");
    expect(() => parseReporterLine("not json")).toThrow();
    expect(() => parseReporterLine('{"move":"nope","flags":[],"say":"x","quote_used":null}')).toThrow();
  });

  it("retries once on invalid JSON, with generous max_tokens and minimal reasoning", async () => {
    const llm = new FakeLlm(["garbage, no json", VALID]);
    const brain = new JournalistBrain(llm, PROMPTS);
    const line = await brain.nextTurn(cafeScenario, [], "We fixed it.");
    expect(line.say).toContain("not what I asked");
    expect(llm.calls).toBe(2);
    expect(llm.lastMaxTokens).toBeGreaterThanOrEqual(1500);
    expect(llm.lastReasoning).toBe("minimal");
  });

  it("uses the generated opening question directly, with no LLM call", async () => {
    const llm = new FakeLlm([VALID]);
    const brain = new JournalistBrain(llm, PROMPTS);
    const line = await brain.openingQuestion(cafeTestScenario);
    expect(line.say).toBe(cafeTestScenario.journalists[0]!.opening_question);
    expect(llm.calls).toBe(0);
  });

  it("reveals landmines to the journalist only after their time has passed", async () => {
    const llm = new FakeLlm([VALID]);
    const brain = new JournalistBrain(llm, PROMPTS);
    await brain.nextTurn(cafeTestScenario, [], "We fixed it.", 30);
    expect(llm.lastPrompt).toContain("mines:None yet.");
    await brain.nextTurn(cafeTestScenario, [], "We fixed it.", 90);
    expect(llm.lastPrompt).toContain("display case cracked two days earlier");
    expect(llm.lastPrompt).not.toContain("second customer messaged");
  });

  it("throws after the single retry also fails", async () => {
    const llm = new FakeLlm(["nope", "still nope"]);
    const brain = new JournalistBrain(llm, PROMPTS);
    await expect(brain.nextTurn(cafeScenario, [], "x")).rejects.toThrow(/after one retry/);
    expect(llm.calls).toBe(2);
  });
});

describe("SessionOrchestrator (fake adapters)", () => {
  async function started(brainOverride?: { nextTurn?: (scenario: unknown, history: unknown, answer: string) => Promise<ReporterLine>; turnEndSilenceMs?: number }) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, audio, sink } = makeSink();
    const brainCalls: string[] = [];
    const brain = {
      openingQuestion: async () => OPENING,
      nextTurn: async (_s: unknown, _h: unknown, answer: string) => {
        brainCalls.push(answer);
        return brainOverride?.nextTurn ? brainOverride.nextTurn(_s, _h, answer) : parseReporterLine(VALID);
      },
    };
    const logs: string[] = [];
    const orch = new SessionOrchestrator({
      stt,
      brain: brain as never,
      tts,
      sink,
      scenario: cafeScenario,
      voiceId: "voice-1",
      turnEndSilenceMs: brainOverride?.turnEndSilenceMs ?? 0,
      log: (l) => logs.push(l),
    });
    await orch.start();
    await orch.playbackDone();
    return { stt, tts, messages, audio, orch, logs, brainCalls };
  }

  it("speaks the opening, then listens (state order thinking/speaking/listening)", async () => {
    const { messages, audio, tts } = await started();
    const states = messages.filter((m) => m.type === "state").map((m) => (m.type === "state" ? m.state : ""));
    expect(states).toEqual(["thinking", "speaking", "listening"]);
    expect(messages.some((m) => m.type === "reporter_line")).toBe(true);
    expect(audio.length).toBe(2);
    expect(tts.texts[0]).toBe(OPENING.say);
    expect(messages.some((m) => m.type === "audio_end")).toBe(true);
  });

  it("final transcript flows LLM to TTS to client, with timing fields", async () => {
    const { stt, tts, messages, orch, logs } = await started();
    orch.pushAudio(new Uint8Array([9, 9]));
    expect(stt.sessions[0]!.pushed).toHaveLength(1);

    stt.sessions[0]!.emit({ type: "endpoint" });
    stt.sessions[0]!.emit({ type: "final", text: "We had no idea about the case.", turnId: "t1" });
    await tick();
    await tick();
    await orch.playbackDone();

    const states = messages.filter((m) => m.type === "state").map((m) => (m.type === "state" ? m.state : ""));
    expect(states).toEqual(["thinking", "speaking", "listening", "thinking", "speaking", "listening"]);
    expect(messages).toContainEqual({ type: "transcript", role: "user", text: "We had no idea about the case." });
    expect(messages).toContainEqual({
      type: "reporter_line",
      line: expect.objectContaining({ move: "follow_up", flags: ["dodge"] }),
    });
    expect(tts.texts[1]).toContain("not what I asked");
    const timingMsgs = messages.filter((m) => m.type === "timing");
    expect(timingMsgs.length).toBeGreaterThanOrEqual(2);
    const turnTiming = timingMsgs[timingMsgs.length - 1]!;
    if (turnTiming.type !== "timing") throw new Error("expected timing");
    expect(turnTiming.timing.turn).toBe(1);
    for (const k of ["speechEndToFinalMs", "speechEndToLlmMs", "speechEndToFirstAudioMs", "totalToFirstAudioMs"] as const) {
      expect(typeof turnTiming.timing[k]).toBe("number");
      expect(turnTiming.timing[k]).toBeGreaterThanOrEqual(0);
    }
    expect(turnTiming.timing.speechEndToFirstAudioMs).toBeGreaterThanOrEqual(turnTiming.timing.speechEndToLlmMs);
    expect(logs.some((l) => l.includes("[turn 1]"))).toBe(true);
  });

  it("concatenates two finals 600 ms apart into one turn (1500 ms silence)", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, brainCalls, orch } = await started({ turnEndSilenceMs: 1500 });
      const s = stt.sessions[0]!;
      s.emit({ type: "final", text: "We take this extremely seriously." });
      await vi.advanceTimersByTimeAsync(600);
      // Speculative turn has already started on the first final.
      expect(brainCalls).toEqual(["We take this extremely seriously."]);
      s.emit({ type: "final", text: "We pulled the pastries that morning." });
      await vi.advanceTimersByTimeAsync(1499);
      expect(brainCalls).toEqual([
        "We take this extremely seriously.",
        "We take this extremely seriously. We pulled the pastries that morning.",
      ]);
      await vi.advanceTimersByTimeAsync(1);
      // The turn speaks only once, with the combined answer; no extra LLM call at window close.
      expect(brainCalls).toHaveLength(2);
      expect(messages).toContainEqual({
        type: "transcript",
        role: "user",
        text: "We take this extremely seriously. We pulled the pastries that morning.",
      });
      expect(stt.sessions.length).toBe(1);
      await orch.playbackDone();
      expect(stt.sessions.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 1500 ms gap after a final ends the turn; a partial postpones it", async () => {
    vi.useFakeTimers();
    try {
      const { stt, brainCalls } = await started({ turnEndSilenceMs: 1500 });
      const s = stt.sessions[0]!;
      s.emit({ type: "final", text: "First part." });
      await vi.advanceTimersByTimeAsync(0);
      expect(brainCalls).toEqual(["First part."]);
      await vi.advanceTimersByTimeAsync(1000);
      s.emit({ type: "partial", text: "First part. And" });
      await vi.advanceTimersByTimeAsync(1499);
      // Partial aborted the speculative call, and no fresh call until the window closes.
      expect(brainCalls).toEqual(["First part."]);
      await vi.advanceTimersByTimeAsync(1);
      // Fresh call at window close with the same (final) answer.
      expect(brainCalls).toEqual(["First part.", "First part."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores empty and whitespace-only finals (no LLM call, no turn)", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, brainCalls, orch } = await started({ turnEndSilenceMs: 1500 });
      const s = stt.sessions[0]!;
      s.emit({ type: "final", text: "" });
      s.emit({ type: "final", text: "   " });
      await vi.advanceTimersByTimeAsync(5000);
      expect(brainCalls).toHaveLength(0);
      expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
      expect(orch.currentState).toBe("listening");
      expect(stt.sessions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("half duplex: mic frames are dropped while not listening", async () => {
    let releaseBrain!: (line: ReporterLine) => void;
    const gate = new Promise<ReporterLine>((r) => {
      releaseBrain = r;
    });
    const { stt, orch } = await started({ nextTurn: () => gate });
    const first = stt.sessions[0]!;
    orch.pushAudio(new Uint8Array([1]));
    expect(first.pushed).toHaveLength(1);
    first.emit({ type: "endpoint" });
    first.emit({ type: "final", text: "Answer.", turnId: "t1" });
    await tick();
    await tick();
    expect(orch.currentState).toBe("thinking");
    orch.pushAudio(new Uint8Array([2]));
    releaseBrain(parseReporterLine(VALID));
    await tick();
    await tick();
    const allPushed = stt.sessions.flatMap((s) => s.pushed);
    expect(allPushed).toHaveLength(1);
    expect(orch.currentState).toBe("speaking");
    await orch.playbackDone();
    expect(orch.currentState).toBe("listening");
    // Listening again on the fresh session: pushes flow there.
    orch.pushAudio(new Uint8Array([3]));
    expect(stt.sessions[stt.sessions.length - 1]!.pushed).toHaveLength(1);
  });
});

class CountingAbortLlm implements Llm {
  calls = 0;
  aborts = 0;
  prompts: string[] = [];
  async chat(input: { messages?: Array<{ content: string }>; signal?: AbortSignal }): Promise<LlmChatResult> {
    this.calls += 1;
    const prompt = input.messages?.[0]?.content ?? "";
    this.prompts.push(prompt);
    const answer = prompt.startsWith("T ") ? prompt.slice(2, prompt.indexOf(" facts:")) : "?";
    const text = JSON.stringify({ move: "follow_up", flags: [], say: `Reply to: ${answer}`, quote_used: null });
    const signal = input.signal;
    if (!signal) return { text, model: "fake", finishReason: "stop" };
    return new Promise<LlmChatResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text, model: "fake", finishReason: "stop" }), 250);
      signal.addEventListener(
        "abort",
        () => {
          this.aborts += 1;
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    });
  }
  async generateStructured<T>(): Promise<T> {
    throw new Error("not used");
  }
}

describe("Speculative turn (fake STT + fake LLM counting calls and aborts)", () => {
  async function startedWithRealBrain() {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, sink } = makeSink();
    const llm = new CountingAbortLlm();
    const brain = new JournalistBrain(llm as never, PROMPTS);
    const orch = new SessionOrchestrator({
      stt,
      brain,
      tts,
      sink,
      scenario: cafeTestScenario,
      voiceId: "voice-1",
      turnEndSilenceMs: 100,
    });
    await orch.start();
    await orch.playbackDone();
    llm.calls = 0;
    llm.aborts = 0;
    llm.prompts = [];
    tts.texts = [];
    return { stt, tts, messages, orch, llm };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("starts the LLM on the first final, during the silence window, and reuses its result", async () => {
    const { stt, tts, orch, llm } = await startedWithRealBrain();
    stt.sessions[0]!.emit({ type: "final", text: "We fixed it." });
    await wait(10);
    expect(llm.calls).toBe(1);
    expect(orch.currentState).toBe("listening");
    await wait(400);
    expect(llm.calls).toBe(1);
    expect(llm.aborts).toBe(0);
    expect(tts.texts[0]).toBe("Reply to: We fixed it.");
    expect(orch.currentState).toBe("speaking");
    await orch.playbackDone();
    expect(orch.currentState).toBe("listening");
  });

  it("aborts the speculative call when more speech arrives and never speaks the shorter reply", async () => {
    const { stt, tts, messages, llm } = await startedWithRealBrain();
    stt.sessions[0]!.emit({ type: "final", text: "We fixed it." });
    await wait(10);
    expect(llm.calls).toBe(1);
    stt.sessions[0]!.emit({ type: "final", text: "And we paid compensation." });
    await wait(10);
    expect(llm.aborts).toBe(1);
    expect(llm.calls).toBe(2);
    await wait(500);
    expect(llm.calls).toBe(2);
    expect(tts.texts).toContain("Reply to: We fixed it. And we paid compensation.");
    expect(tts.texts).not.toContain("Reply to: We fixed it.");
    const reporterTexts = messages.filter((m) => m.type === "transcript" && m.role === "reporter").map((m) => (m.type === "transcript" ? m.text : ""));
    expect(reporterTexts).not.toContain("Reply to: We fixed it.");
  });
});

/** STT session that fails like Muse Voice Transcribe after >1 s without audio. */
class GapSession implements SttSession {
  pushed: Uint8Array[] = [];
  ended = false;
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  private lastPushAt = Date.now();
  private closed = false;
  private failed = false;
  private readonly timer = setInterval(() => {
    if (this.closed || this.failed) return;
    if (Date.now() - this.lastPushAt > 1000) {
      this.failed = true;
      this.emit({ type: "error", message: "Ingress audio slower than real-time" });
    }
  }, 25);
  push(pcm: Uint8Array): void {
    this.pushed.push(pcm);
    this.lastPushAt = Date.now();
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>);
  }
  /** Simulate the remote side closing the socket unexpectedly. */
  remoteClose(): void {
    this.close();
  }
  onPartial(_cb: (t: string) => void): void {
    /* noop */
  }
  emit(ev: SttEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    const isClosed = () => this.closed;
    return {
      [Symbol.asyncIterator]: () => ({
        next(): Promise<IteratorResult<SttEvent>> {
          const q = queue.shift();
          if (q) return Promise.resolve({ value: q, done: false });
          if (isClosed()) return Promise.resolve({ value: undefined, done: true } as IteratorResult<SttEvent>);
          return new Promise((r) => waiters.push(r));
        },
      }),
    };
  }
}

class GapStt implements SpeechToText {
  sessions: GapSession[] = [];
  failNextOpens = 0;
  async openSession(): Promise<SttSession> {
    if (this.failNextOpens > 0) {
      this.failNextOpens -= 1;
      throw new Error("open failed");
    }
    const s = new GapSession();
    this.sessions.push(s);
    return s;
  }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> {
    yield { text: "", isFinal: true };
  }
}

describe("Realtime ingress (brief 05a, gap-sensitive fake STT)", () => {
  function makeOrch(stt: GapStt, opts: { turnEndSilenceMs?: number } = {}) {
    const tts = new FakeTts();
    const { messages, sink } = makeSink();
    const logs: string[] = [];
    const brain = {
      openingQuestion: async () => OPENING,
      nextTurn: async () => parseReporterLine(VALID),
    };
    const orch = new SessionOrchestrator({
      stt,
      brain: brain as never,
      tts,
      sink,
      scenario: cafeScenario,
      voiceId: "voice-1",
      turnEndSilenceMs: opts.turnEndSilenceMs ?? 50,
      now: () => Date.now(),
      log: (l) => logs.push(l),
    });
    return { orch, messages, logs, tts };
  }
  const errors = (messages: ServerMessage[]) => messages.filter((m) => m.type === "error");

  it("opens no STT session before playback_done, and stays speaking until then", async () => {
    const stt = new GapStt();
    const { orch, messages } = makeOrch(stt);
    await orch.start();
    expect(stt.sessions).toHaveLength(0);
    expect(orch.currentState).toBe("speaking");
    orch.pushAudio(new Uint8Array([1, 2]));
    await tick();
    expect(stt.sessions).toHaveLength(0);
    await orch.playbackDone();
    expect(stt.sessions).toHaveLength(1);
    expect(orch.currentState).toBe("listening");
    expect(errors(messages)).toHaveLength(0);
    await orch.stop();
  });

  it("pushes 100 ms silence frames so a >1 s gap never fails the session", async () => {
    vi.useFakeTimers();
    try {
      const stt = new GapStt();
      const { orch, messages } = makeOrch(stt);
      await orch.start();
      await orch.playbackDone();
      const session = stt.sessions[0]!;
      await vi.advanceTimersByTimeAsync(3000);
      // No mic frames arrived, yet the gap-sensitive fake never errored.
      expect(stt.sessions).toHaveLength(1);
      expect(errors(messages)).toHaveLength(0);
      expect(orch.currentState).toBe("listening");
      expect(session.pushed.length).toBeGreaterThan(0);
      for (const frame of session.pushed) {
        expect(frame).toHaveLength(3200);
        expect(frame.every((b) => b === 0)).toBe(true);
      }
      await orch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an STT error mid-turn reopens the session and keeps the collected answer", async () => {
    const stt = new GapStt();
    const { orch, messages, logs } = makeOrch(stt);
    await orch.start();
    await orch.playbackDone();
    stt.sessions[0]!.emit({ type: "final", text: "First part." });
    await tick();
    stt.sessions[0]!.emit({ type: "error", message: "Ingress audio slower than real-time" });
    await tick();
    await tick();
    expect(stt.sessions).toHaveLength(2);
    expect(errors(messages)).toHaveLength(0);
    expect(orch.currentState).toBe("listening");
    expect(logs.some((l) => l.includes("reopening"))).toBe(true);
    stt.sessions[1]!.emit({ type: "final", text: "Second part." });
    await new Promise((r) => setTimeout(r, 200));
    expect(messages).toContainEqual({ type: "transcript", role: "user", text: "First part. Second part." });
    expect(errors(messages)).toHaveLength(0);
    await orch.stop();
  });

  it("an unexpected STT close mid-turn also reopens without an error", async () => {
    const stt = new GapStt();
    const { orch, messages } = makeOrch(stt);
    await orch.start();
    await orch.playbackDone();
    stt.sessions[0]!.remoteClose();
    await tick();
    await tick();
    expect(stt.sessions).toHaveLength(2);
    expect(errors(messages)).toHaveLength(0);
    expect(orch.currentState).toBe("listening");
    await orch.stop();
  });

  it("shows an error only after two reopen attempts in a row fail", async () => {
    const stt = new GapStt();
    const { orch, messages } = makeOrch(stt);
    await orch.start();
    await orch.playbackDone();
    stt.failNextOpens = 2;
    stt.sessions[0]!.emit({ type: "error", message: "boom" });
    await tick();
    await tick();
    await tick();
    expect(stt.sessions).toHaveLength(1);
    expect(errors(messages)).toHaveLength(1);
    await orch.stop();
  });
});

describe("Escalations (brief 06)", () => {
  async function startedEsc(scenario = cafeTestScenario) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const messages: ServerMessage[] = [];
    const events: string[] = [];
    const sink: ClientSink = {
      send: (m) => { messages.push(m); events.push(m.type); },
      sendAudio: () => { events.push("audio"); },
    };
    const llm = new FakeLlm([VALID]);
    const brain = new JournalistBrain(llm, PROMPTS);
    const record: SessionRecord = { id: "s1", scenario, startedAtMs: 0, turns: [] };
    let nowMs = 0;
    const orch = new SessionOrchestrator({
      stt, brain, tts, sink, scenario, voiceId: "voice-1",
      turnEndSilenceMs: 0, now: () => nowMs, record,
    });
    await orch.start();
    await orch.playbackDone();
    const answer = async (text: string) => {
      const s = stt.sessions[stt.sessions.length - 1]!;
      s.emit({ type: "endpoint" });
      s.emit({ type: "final", text, turnId: "t" });
      for (let i = 0; i < 12; i++) await tick();
      await orch.playbackDone();
      for (let i = 0; i < 4; i++) await tick();
    };
    return { stt, tts, messages, events, orch, llm, record, answer, setNow: (s: number) => { nowMs = s * 1000; } };
  }

  it("fires at the first turn boundary after at_seconds, not before, with news voice and order", async () => {
    const h = await startedEsc();
    h.setNow(119);
    await h.answer("We acted that morning.");
    expect(h.messages.some((m) => m.type === "news_flash")).toBe(false);
    const mark = h.events.length;
    h.setNow(121);
    await h.answer("We are sorry.");
    expect(h.messages).toContainEqual({ type: "news_flash", text: "A second post about the café is spreading", atSeconds: 121 });
    // Journalist prompt received the new fact.
    expect(h.llm.lastPrompt).toContain("A second customer has posted");
    // News spoken with Daniel voice / turbo model, before reporter line.
    const newsIdx = h.tts.texts.indexOf("A second post about the café is spreading");
    expect(newsIdx).toBeGreaterThanOrEqual(0);
    expect(h.tts.options[newsIdx]).toEqual({ voiceId: "3WqHLnw80rOZqJzW9YRB", model: "eleven_v4_turbo" });
    const ordered = h.events.slice(mark).filter((e) => ["news_flash", "audio", "reporter_line", "audio_end"].includes(e));
    expect(ordered).toEqual(["news_flash", "audio", "audio", "reporter_line", "audio", "audio", "audio_end"]);
    // Recorded for debrief {events} with mm:ss.
    expect(h.record.turns).toContainEqual(expect.objectContaining({ role: "news", text: "A second post about the café is spreading", elapsedSeconds: 121 }));
    expect(formatEvents(h.record.turns)).toContain("[02:01] News: A second post about the café is spreading");
    await h.orch.stop();
  });

  it("fires only one escalation per turn, earliest first", async () => {
    const scenario = {
      ...cafeTestScenario,
      escalations: [
        { at_seconds: 10, news_flash: "First flash", gives_journalist: "J1", new_fact: "fact one" },
        { at_seconds: 20, news_flash: "Second flash", gives_journalist: "J1", new_fact: "fact two" },
      ],
    };
    const h = await startedEsc(scenario);
    h.setNow(100);
    await h.answer("Answer one.");
    expect(h.messages.filter((m) => m.type === "news_flash")).toEqual([{ type: "news_flash", text: "First flash", atSeconds: 100 }]);
    expect(h.llm.lastPrompt).toContain("fact one");
    expect(h.llm.lastPrompt).not.toContain("fact two");
    await h.answer("Answer two.");
    expect(h.messages.filter((m) => m.type === "news_flash").map((m) => (m.type === "news_flash" ? m.text : ""))).toEqual(["First flash", "Second flash"]);
    expect(h.llm.lastPrompt).toContain("fact two");
    await h.orch.stop();
  });
});
