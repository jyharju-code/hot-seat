import { describe, expect, it, vi } from "vitest";
import type { ReporterLine, ServerMessage } from "@hot-seat/shared";
import { JournalistBrain, parseReporterLine, type JournalistPrompts } from "../src/journalist.js";
import type { Llm, LlmChatResult } from "../src/providers/llm.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";
import { cafeScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { SessionOrchestrator, type ClientSink } from "../src/session/orchestrator.js";
import { formatEvents, type SessionRecord } from "../src/session/store.js";
import { isInterruptDecisionStale, LlmInterruptDecider, parseInterruptDecision, type InterruptDecision, type InterruptDecisionInput } from "../src/interrupt.js";

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
  closed = false;
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(pcm: Uint8Array): void {
    this.pushed.push(pcm);
  }
  end(): void {
    this.ended = true;
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>);
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
    expect(parseReporterLine(JSON.stringify({ move: "follow_up", flags: [], say: "x", quote_used: null, owner_done: false })).owner_done).toBe(false);
    expect(parseReporterLine(JSON.stringify({ move: "follow_up", flags: [], say: "x", quote_used: null, owner_done: true })).owner_done).toBe(true);
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
    await brain.nextTurn(cafeTestScenario, [], "We fixed it.", 50);
    expect(llm.lastPrompt).toContain("display case cracked two days earlier");
    expect(llm.lastPrompt).not.toContain("second customer messaged");
  });

  it("passes only the last 6 conversation turns as transcript_tail and logs prompt size", async () => {
    const llm = new FakeLlm([VALID]);
    const logs: string[] = [];
    const prompts: JournalistPrompts = {
      spokenStyle: "STYLE",
      journalistTurn: "TAIL<<{transcript_tail}>> {last_answer} {spoken_style} {public_facts} {landmines_known_to_you}",
      openingQuestion: "O",
    };
    const brain = new JournalistBrain(llm, prompts, "muse-spark-1.3", (l) => logs.push(l));
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "reporter" : "user") as "reporter" | "user",
      text: `turn-${i}`,
    }));
    await brain.nextTurn(cafeScenario, history, "last");
    expect(llm.lastPrompt).toContain("turn-4");
    expect(llm.lastPrompt).toContain("turn-9");
    expect(llm.lastPrompt).not.toContain("turn-3");
    expect(logs.some((l) => l === `[turn] prompt chars=${llm.lastPrompt.length}`)).toBe(true);
  });

  it("throws after the single retry also fails", async () => {
    const llm = new FakeLlm(["nope", "still nope"]);
    const brain = new JournalistBrain(llm, PROMPTS);
    await expect(brain.nextTurn(cafeScenario, [], "x")).rejects.toThrow(/after one retry/);
    expect(llm.calls).toBe(2);
  });
});

describe("SessionOrchestrator (fake adapters)", () => {
  async function started(brainOverride?: { nextTurn?: (scenario: unknown, history: unknown, answer: string) => Promise<ReporterLine>; turnEndSilenceMs?: number; turnEndHesitantMs?: number }) {
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
      turnEndHesitantMs: brainOverride?.turnEndHesitantMs ?? brainOverride?.turnEndSilenceMs ?? 0,
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

  it("hesitant answer gets the extended window; speculative call still starts at the first final", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, brainCalls, orch } = await started({ turnEndSilenceMs: 1500, turnEndHesitantMs: 3200 });
      const s = stt.sessions[0]!;
      s.emit({ type: "final", text: "well, so the thing is I, let me think." });
      await vi.advanceTimersByTimeAsync(0);
      // Speculative LLM call started at the first final, not after the window.
      expect(brainCalls).toEqual(["well, so the thing is I, let me think."]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
      expect(orch.currentState).toBe("listening");
      await vi.advanceTimersByTimeAsync(1699);
      expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toContainEqual({
        type: "transcript",
        role: "user",
        text: "well, so the thing is I, let me think.",
      });
      // The speculative result was reused: no second LLM call at window close.
      expect(brainCalls).toHaveLength(1);
      await orch.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owner_done false keeps waiting past the normal window for a complete sentence", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stt, messages, orch } = await started({
      turnEndSilenceMs: 100,
      turnEndHesitantMs: 800,
      nextTurn: async () => ({ ...parseReporterLine(VALID), owner_done: false }),
    });
    const complete = "We closed the cafe that morning and told every customer directly today.";
    stt.sessions[0]!.emit({ type: "final", text: complete });
    await wait(250);
    expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
    await wait(700);
    expect(messages).toContainEqual({ type: "transcript", role: "user", text: complete });
    await orch.stop();
  });

  it("owner_done true ends hesitant wording at the normal window and flushes speculative TTS", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stt, tts, messages, audio, orch } = await started({
      turnEndSilenceMs: 100,
      turnEndHesitantMs: 800,
      nextTurn: async () => ({ ...parseReporterLine(VALID), owner_done: true }),
    });
    const openingAudio = audio.length;
    stt.sessions[0]!.emit({ type: "final", text: "well, so the thing is I, let me think." });
    await wait(30);
    // Speculative TTS has started but no audio has been sent before turn end.
    expect(tts.texts.length).toBeGreaterThan(1);
    expect(audio.length).toBe(openingAudio);
    await wait(250);
    expect(messages).toContainEqual({ type: "transcript", role: "user", text: "well, so the thing is I, let me think." });
    expect(audio.length).toBeGreaterThan(openingAudio);
    const timing = messages.filter((m) => m.type === "timing").at(-1);
    if (!timing || timing.type !== "timing") throw new Error("expected timing");
    expect(timing.timing.speculativeTtsUsed).toBe(true);
    await orch.stop();
  });

  it("slow LLM (owner_done true) ends the turn when it arrives, not at the silence window", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stt, messages, orch } = await started({
      turnEndSilenceMs: 100,
      turnEndHesitantMs: 1000,
      nextTurn: async () => {
        await wait(250);
        return { ...parseReporterLine(VALID), owner_done: true };
      },
    });
    const complete = "We closed the cafe that morning and told every customer directly today.";
    stt.sessions[0]!.emit({ type: "final", text: complete });
    await wait(180);
    // 100 ms window passed but the LLM has not replied: no turn end yet.
    expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
    await wait(250);
    expect(messages).toContainEqual({ type: "transcript", role: "user", text: complete });
    await orch.stop();
  });

  it("speech resuming while the LLM is pending aborts it and restarts for the longer answer", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const calls: string[] = [];
    const { stt, messages, orch } = await started({
      turnEndSilenceMs: 100,
      turnEndHesitantMs: 1000,
      nextTurn: async (_s: unknown, _h: unknown, answer: string) => {
        calls.push(answer);
        await wait(250);
        return { ...parseReporterLine(VALID), owner_done: true };
      },
    });
    const s = stt.sessions[0]!;
    s.emit({ type: "final", text: "Yeah, yeah," });
    await wait(150);
    s.emit({ type: "final", text: "we refunded everyone that morning." });
    await wait(150);
    expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
    await wait(300);
    expect(messages).toContainEqual({
      type: "transcript",
      role: "user",
      text: "Yeah, yeah, we refunded everyone that morning.",
    });
    expect(calls).toEqual(["Yeah, yeah,", "Yeah, yeah, we refunded everyone that morning."]);
    await orch.stop();
  });

  it("LLM error falls back to the word heuristic", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stt, messages, orch } = await started({
      turnEndSilenceMs: 100,
      turnEndHesitantMs: 800,
      nextTurn: async () => {
        await wait(30);
        throw new Error("LLM down");
      },
    });
    const complete = "We closed the cafe that morning and told every customer directly today.";
    stt.sessions[0]!.emit({ type: "final", text: complete });
    await wait(50);
    // Error arrived but the heuristic window has not passed yet.
    expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
    await wait(250);
    // handleFinal retries the (failing) brain, so the turn surfaces as an error, not a hang to 800 ms.
    // The key assertion: it did not wait the hesitant cap before acting. Use transcript or error.
    const acted =
      messages.some((m) => m.type === "transcript" && m.role === "user") ||
      messages.some((m) => m.type === "error");
    expect(acted).toBe(true);
    await orch.stop();
  });

  it("speculative TTS buffer is discarded when speech resumes", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stt, tts, audio, orch } = await started({
      turnEndSilenceMs: 150,
      turnEndHesitantMs: 150,
      nextTurn: async () => ({ ...parseReporterLine(VALID), owner_done: true }),
    });
    const openingAudio = audio.length;
    const s = stt.sessions[0]!;
    s.emit({ type: "final", text: "We fixed it." });
    await wait(30);
    expect(tts.texts).toContain(parseReporterLine(VALID).say);
    const ttsCallsAfterFirst = tts.texts.length;
    s.emit({ type: "final", text: "And we paid compensation." });
    await wait(400);
    // Only the final line's audio (2 chunks) was sent, not the discarded buffer.
    expect(tts.texts.length).toBeGreaterThan(ttsCallsAfterFirst);
    expect(audio.length).toBe(openingAudio + 2);
    await orch.stop();
  });

  it("complete answer still ends at the default window, and continued speech aborts speculative", async () => {
    vi.useFakeTimers();
    try {
      const { stt, messages, brainCalls, orch } = await started({ turnEndSilenceMs: 1500, turnEndHesitantMs: 3200 });
      const s = stt.sessions[0]!;
      const complete = "We closed the cafe that morning and told every customer directly today.";
      s.emit({ type: "final", text: complete });
      await vi.advanceTimersByTimeAsync(0);
      expect(brainCalls).toEqual([complete]);
      // More speech arrives inside the window: speculative is aborted and
      // the turn continues instead of speaking the shorter reply.
      s.emit({ type: "final", text: "And we refunded everyone." });
      await vi.advanceTimersByTimeAsync(1499);
      expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toContainEqual({
        type: "transcript",
        role: "user",
        text: `${complete} And we refunded everyone.`,
      });
      expect(brainCalls).toEqual([complete, `${complete} And we refunded everyone.`]);
      await orch.stop();
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
      turnEndSilenceMs: 100, turnEndHesitantMs: 100,
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

describe("Stable-partial speculative start (brief 09e)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function startedPartial(delayMs = 10) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, sink } = makeSink();
    const calls: string[] = [];
    let aborts = 0;
    const brain = {
      openingQuestion: async () => OPENING,
      nextTurn: async (_s: unknown, _h: unknown, answer: string, _e?: number, signal?: AbortSignal) => {
        calls.push(answer);
        if (signal) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, delayMs);
            signal.addEventListener("abort", () => { aborts += 1; clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); }, { once: true });
          });
        } else {
          await wait(delayMs);
        }
        return { ...parseReporterLine(VALID), say: `Reply to: ${answer}` };
      },
    };
    const orch = new SessionOrchestrator({
      stt, brain: brain as never, tts, sink, scenario: cafeScenario, voiceId: "voice-1",
      turnEndSilenceMs: 80, turnEndHesitantMs: 80, partialStableMs: 40,
    });
    await orch.start();
    await orch.playbackDone();
    const lastTiming = () => {
      const t = messages.filter((m) => m.type === "timing").at(-1);
      if (!t || t.type !== "timing") throw new Error("expected timing");
      return t.timing;
    };
    return { stt, tts, messages, orch, calls, lastTiming, aborts: () => aborts };
  }

  it("stable partial starts the call; a short partial does not", async () => {
    const h = await startedPartial();
    const s = h.stt.sessions[0]!;
    s.emit({ type: "partial", text: "We closed" });
    await wait(90);
    expect(h.calls).toEqual([]);
    s.emit({ type: "partial", text: "We closed the cafe" });
    await wait(15);
    expect(h.calls).toEqual([]);
    await wait(80);
    expect(h.calls).toEqual(["We closed the cafe"]);
    await h.orch.stop();
  });

  it("equal final (punctuation and casing only) keeps the partial-started call", async () => {
    const h = await startedPartial();
    const s = h.stt.sessions[0]!;
    s.emit({ type: "partial", text: "We closed the cafe today." });
    await wait(90);
    expect(h.calls).toEqual(["We closed the cafe today."]);
    s.emit({ type: "final", text: "we closed the cafe today" });
    await wait(250);
    expect(h.calls).toEqual(["We closed the cafe today."]);
    expect(h.messages).toContainEqual({ type: "transcript", role: "user", text: "we closed the cafe today" });
    expect(h.lastTiming().partialStartUsed).toBe(true);
    await h.orch.stop();
  });

  it("different final restarts the call with the final text", async () => {
    const h = await startedPartial();
    const s = h.stt.sessions[0]!;
    s.emit({ type: "partial", text: "We closed the cafe today." });
    await wait(90);
    expect(h.calls).toEqual(["We closed the cafe today."]);
    s.emit({ type: "final", text: "We refunded every customer yesterday." });
    await wait(250);
    expect(h.calls).toEqual(["We closed the cafe today.", "We refunded every customer yesterday."]);
    expect(h.lastTiming().partialStartUsed).toBe(false);
    await h.orch.stop();
  });

  it("new partial words abort the in-flight partial-started call", async () => {
    const h = await startedPartial(300);
    const s = h.stt.sessions[0]!;
    s.emit({ type: "partial", text: "We closed the cafe today." });
    await wait(90);
    expect(h.calls).toEqual(["We closed the cafe today."]);
    s.emit({ type: "partial", text: "We closed the cafe today and refunded everyone" });
    await wait(20);
    expect(h.aborts()).toBe(1);
    // After the new text is stable, a fresh call starts for it; the first
    // reply is never spoken.
    await wait(90);
    expect(h.calls).toEqual(["We closed the cafe today.", "We closed the cafe today and refunded everyone"]);
    s.emit({ type: "final", text: "We closed the cafe today and refunded everyone" });
    await wait(500);
    const reporterTexts = h.messages.filter((m) => m.type === "transcript" && m.role === "reporter").map((m) => (m.type === "transcript" ? m.text : ""));
    expect(reporterTexts).not.toContain("Reply to: We closed the cafe today.");
    expect(h.lastTiming().partialStartUsed).toBe(true);
    await h.orch.stop();
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
      turnEndSilenceMs: opts.turnEndSilenceMs ?? 50, turnEndHesitantMs: opts.turnEndSilenceMs ?? 50,
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
        expect(frame.every((b) => b === 0)).toBe(true);
      }
      // Top-ups track wall time: about 3 s of audio was sent in 3 s.
      const totalMs = session.pushed.reduce((sum, f) => sum + f.length / 32, 0);
      expect(totalMs).toBeGreaterThan(2800);
      expect(totalMs).toBeLessThan(3200);
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
    // Reopen waits out the 250 ms reconnect backoff (brief 08 item 3).
    // Poll so the second final lands inside the reopened turn's window.
    for (let i = 0; i < 100 && stt.sessions.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
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
    await new Promise((r) => setTimeout(r, 300));
    await tick();
    expect(stt.sessions).toHaveLength(2);
    expect(errors(messages)).toHaveLength(0);
    expect(orch.currentState).toBe("listening");
    await orch.stop();
  });

  it("shows an error only after three consecutive STT failures in the turn (brief 08 item 3)", async () => {
    const stt = new GapStt();
    const { orch, messages } = makeOrch(stt);
    await orch.start();
    await orch.playbackDone();
    stt.failNextOpens = 2;
    stt.sessions[0]!.emit({ type: "error", message: "boom" });
    // Dead session (1) + two failed opens (2, 3) with 250/500 ms backoff.
    await new Promise((r) => setTimeout(r, 1100));
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
      turnEndSilenceMs: 0, turnEndHesitantMs: 0, now: () => nowMs, record,
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
    expect(h.tts.options[newsIdx]).toEqual({ voiceId: "3WqHLnw80rOZqJzW9YRB", model: "eleven_v4_turbo", signal: expect.any(AbortSignal) });
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

describe("Interruptions (brief 07)", () => {
  class FakeDecider {
    calls: InterruptDecisionInput[] = [];
    constructor(private readonly handler: (input: InterruptDecisionInput, n: number) => Promise<InterruptDecision> | InterruptDecision) {}
    async decide(input: InterruptDecisionInput): Promise<InterruptDecision> {
      this.calls.push(input);
      return this.handler(input, this.calls.length);
    }
  }
  const NO: InterruptDecision = { interrupt: false, reason: "", say: "" };
  const YES: InterruptDecision = { interrupt: true, reason: "repeating a scripted line", say: "[interrupting] Sorry, when did you know?" };

  async function startedInterrupt(decider: FakeDecider, opts: { enabled?: boolean } = {}) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, audio, sink } = makeSink();
    const logs: string[] = [];
    let nowMs = 0;
    const record: SessionRecord = { id: "s-int", scenario: cafeScenario as never, startedAtMs: 0, turns: [] };
    const brain = { openingQuestion: async () => OPENING, nextTurn: async () => parseReporterLine(VALID) };
    const orch = new SessionOrchestrator({
      stt, brain: brain as never, tts, sink, scenario: cafeScenario, voiceId: "voice-1",
      turnEndSilenceMs: 20, turnEndHesitantMs: 20, now: () => nowMs, log: (l) => logs.push(l), record,
      interruptDecider: decider, interruptsEnabled: opts.enabled ?? true,
    });
    await orch.start();
    await orch.playbackDone();
    return { stt, tts, messages, audio, orch, logs, record, setNow: (ms: number) => { nowMs = ms; }, session: () => stt.sessions[stt.sessions.length - 1]! };
  }
  const ticks = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };

  it("decider parses JSON and the LLM decider uses minimal reasoning with a filled prompt", async () => {
    expect(parseInterruptDecision('{"interrupt":false}')).toEqual({ interrupt: false, reason: "", say: "" });
    expect(parseInterruptDecision('{"interrupt":true,"reason":"dodge","say":""}')).toEqual({ interrupt: false, reason: "dodge", say: "" });
    const llm = new FakeLlm([JSON.stringify(YES)]);
    const decider = new LlmInterruptDecider(llm, "Q {name} {outlet} {question} {seconds} {partial} {facts}", "turn-model");
    const out = await decider.decide({ name: "Walter", outlet: "Courier", question: "When?", seconds: 26, partial: "we take this very seriously", facts: "fact one" });
    expect(out).toEqual(YES);
    expect(llm.lastReasoning).toBe("minimal");
    expect(llm.lastPrompt).toContain("Walter Courier When? 26");
    expect(llm.lastPrompt).toContain("fact one");
  });

  it("no decision before 8 s; decisions only when the partial grew and at most every 1.5 s", async () => {
    const decider = new FakeDecider(() => NO);
    const h = await startedInterrupt(decider);
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(5000); s.emit({ type: "partial", text: "We take this very" });
    await ticks();
    expect(decider.calls).toHaveLength(0);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously and" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    expect(decider.calls[0]!.seconds).toBe(9);
    h.setNow(9500); s.emit({ type: "partial", text: "We take this very seriously and also" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    h.setNow(10600); s.emit({ type: "partial", text: "We take this very seriously and also" });
    await ticks();
    // Grown since the last decision and 1.5 s have passed: a new decision.
    expect(decider.calls).toHaveLength(2);
    h.setNow(12200); s.emit({ type: "partial", text: "We take this very seriously and also" });
    await ticks();
    expect(decider.calls).toHaveLength(2);
    h.setNow(12200); s.emit({ type: "partial", text: "We take this very seriously and also more words" });
    await ticks();
    expect(decider.calls).toHaveLength(3);
    await h.orch.stop();
  });

  it("staleness rule: grown partial with the snapshot as prefix is fresh, ended or rewritten is stale", () => {
    const snap = "We take this very seriously";
    expect(isInterruptDecisionStale(snap, "We take this very seriously and furthermore", true)).toBe(false);
    expect(isInterruptDecisionStale(snap, snap, true)).toBe(false);
    expect(isInterruptDecisionStale(snap, "We take this very seriously and furthermore", false)).toBe(true);
    expect(isInterruptDecisionStale(snap, "Something else entirely", true)).toBe(true);
    expect(isInterruptDecisionStale(snap, "", true)).toBe(true);
  });

  it("a decision that lands after the partial grew (same answer) still interrupts, with the grown text", async () => {
    let release!: (d: InterruptDecision) => void;
    const gate = new Promise<InterruptDecision>((r) => { release = r; });
    const decider = new FakeDecider(() => gate);
    const h = await startedInterrupt(decider);
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    s.emit({ type: "partial", text: "We take this very seriously and furthermore" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    release(YES);
    await ticks(12);
    expect(h.messages).toContainEqual({ type: "interrupt", say: YES.say });
    expect(h.messages).toContainEqual({
      type: "transcript",
      role: "user",
      text: "We take this very seriously and furthermore (cut off)",
    });
    expect(h.logs.some((l) => l.includes("stale decision dropped"))).toBe(false);
    await h.orch.stop();
  });

  it("a decision that lands after the answer ended is stale and dropped", async () => {
    let release!: (d: InterruptDecision) => void;
    const gate = new Promise<InterruptDecision>((r) => { release = r; });
    const decider = new FakeDecider(() => gate);
    const h = await startedInterrupt(decider);
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    s.emit({ type: "endpoint" });
    s.emit({ type: "final", text: "We take this very seriously.", turnId: "t1" });
    await new Promise((r) => setTimeout(r, 80));
    await ticks();
    release(YES);
    await ticks();
    expect(h.messages.some((m) => m.type === "interrupt")).toBe(false);
    expect(h.logs.some((l) => l.includes("stale decision dropped"))).toBe(true);
    await h.orch.stop();
  });

  it("reopen at 12 s of a rambling answer: interrupt still fires with full text and elapsed seconds", async () => {
    const decider = new FakeDecider((input) => (input.seconds >= 12 ? YES : NO));
    const h = await startedInterrupt(decider);
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously, we take this very seriously" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    expect(decider.calls[0]!.seconds).toBe(9);
    // STT dies (ingress too slow) and reopens inside the same answer.
    s.emit({ type: "error", message: "Ingress audio slower than real-time" });
    // 250 ms reconnect backoff; poll so the next partial lands in the new turn window.
    for (let i = 0; i < 100 && h.stt.sessions.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.stt.sessions).toHaveLength(2);
    expect(h.messages.some((m) => m.type === "error")).toBe(false);
    // The reopened session only hears new speech; its partial is short.
    h.setNow(12500);
    h.session().emit({ type: "partial", text: "and we keep saying it" });
    await ticks(12);
    expect(decider.calls.length).toBeGreaterThanOrEqual(2);
    const last = decider.calls[decider.calls.length - 1]!;
    expect(last.seconds).toBeGreaterThanOrEqual(12);
    expect(last.partial).toContain("We take this very seriously, we take this very seriously");
    expect(last.partial).toContain("and we keep saying it");
    expect(h.messages).toContainEqual({ type: "interrupt", say: YES.say });
    expect(h.messages).toContainEqual({
      type: "transcript",
      role: "user",
      text: "We take this very seriously, we take this very seriously and we keep saying it (cut off)",
    });
    await h.orch.stop();
  });

  it("interrupt closes STT, plays the cut-in in the reporter voice, and records transcript and debrief event", async () => {
    const decider = new FakeDecider(() => YES);
    const h = await startedInterrupt(decider);
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously, we take this very seriously" });
    await ticks(12);
    expect(s.closed).toBe(true);
    expect(h.messages).toContainEqual({ type: "interrupt", say: YES.say });
    expect(h.messages).toContainEqual({ type: "transcript", role: "user", text: "We take this very seriously, we take this very seriously (cut off)" });
    expect(h.messages).toContainEqual({ type: "transcript", role: "reporter", text: "Sorry, when did you know?" });
    const cutIdx = h.tts.texts.indexOf(YES.say);
    expect(cutIdx).toBeGreaterThanOrEqual(0);
    expect(h.tts.options[cutIdx]).toEqual({ voiceId: "voice-1", model: "eleven_v4_turbo", signal: expect.any(AbortSignal) });
    expect(h.messages.some((m) => m.type === "audio_end")).toBe(true);
    expect(h.orch.currentState).toBe("speaking");
    expect(h.logs.some((l) => l.includes("[interrupt] decision latency"))).toBe(true);
    expect(h.logs.some((l) => l.includes("decision->firstAudio"))).toBe(true);
    expect(h.record.turns).toContainEqual(expect.objectContaining({ role: "user", text: expect.stringContaining("(cut off)"), interruptReason: "repeating a scripted line" }));
    expect(formatEvents(h.record.turns)).toContain("[00:09] Interrupted: repeating a scripted line");
    await h.orch.stop();
  });

  it("never interrupts two answers in a row, but can interrupt again after a normal answer", async () => {
    const decider = new FakeDecider(() => YES);
    const h = await startedInterrupt(decider);
    // Answer 1: interrupted.
    let s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(9000); s.emit({ type: "partial", text: "We take this very seriously, we take this very seriously" });
    await ticks(12);
    expect(h.messages.filter((m) => m.type === "interrupt")).toHaveLength(1);
    await h.orch.playbackDone(); await ticks();
    // Answer 2: no decision at all, then a normal final turn.
    s = h.session();
    h.setNow(20000); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(30000); s.emit({ type: "partial", text: "We take this very seriously for a long time now" });
    await ticks();
    expect(decider.calls).toHaveLength(1);
    s.emit({ type: "endpoint" });
    s.emit({ type: "final", text: "We fixed it that morning.", turnId: "t2" });
    await new Promise((r) => setTimeout(r, 80));
    await ticks();
    expect(h.orch.currentState).toBe("speaking");
    await h.orch.playbackDone(); await ticks();
    // Answer 3: interruption is allowed again, once.
    s = h.session();
    h.setNow(40000); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(50000); s.emit({ type: "partial", text: "We take this very seriously, we take this very seriously again" });
    await ticks(12);
    expect(decider.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.messages.filter((m) => m.type === "interrupt")).toHaveLength(2);
    await h.orch.stop();
  });

  it("INTERRUPTS=off (interruptsEnabled false) never calls the decider", async () => {
    const decider = new FakeDecider(() => YES);
    const h = await startedInterrupt(decider, { enabled: false });
    const s = h.session();
    h.setNow(0); s.emit({ type: "partial", text: "We take" }); await ticks(3);
    h.setNow(20000); s.emit({ type: "partial", text: "We take this very seriously for a very long time" });
    await ticks();
    expect(decider.calls).toHaveLength(0);
    expect(h.messages.some((m) => m.type === "interrupt")).toBe(false);
    await h.orch.stop();
  });
});
