import { describe, expect, it } from "vitest";
import type { ReporterLine, ServerMessage } from "@hot-seat/shared";
import { JournalistBrain, parseReporterLine, type JournalistPrompts } from "../src/journalist.js";
import type { Llm, LlmChatResult } from "../src/providers/llm.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";
import { cafeScenario } from "../src/scenarios/cafe.js";
import { SessionOrchestrator, type ClientSink } from "../src/session/orchestrator.js";

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
const PROMPTS: JournalistPrompts = { spokenStyle: "STYLE", journalistTurn: "T {last_answer} {spoken_style}", openingQuestion: "O" };

class FakeLlm implements Llm {
  calls = 0;
  lastMaxTokens = 0;
  lastReasoning: string | undefined;
  constructor(private readonly replies: string[]) {}
  async chat(input: { maxTokens?: number; reasoningEffort?: string }): Promise<LlmChatResult> {
    this.lastMaxTokens = input.maxTokens ?? 0;
    this.lastReasoning = input.reasoningEffort;
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
  async *synthesize(text: string): AsyncIterable<Uint8Array> {
    this.texts.push(text);
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

  it("throws after the single retry also fails", async () => {
    const llm = new FakeLlm(["nope", "still nope"]);
    const brain = new JournalistBrain(llm, PROMPTS);
    await expect(brain.nextTurn(cafeScenario, [], "x")).rejects.toThrow(/after one retry/);
    expect(llm.calls).toBe(2);
  });
});

describe("SessionOrchestrator (fake adapters)", () => {
  async function started(brainOverride?: { nextTurn: () => Promise<ReporterLine> }) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const { messages, audio, sink } = makeSink();
    const brain = {
      openingQuestion: async () => OPENING,
      nextTurn: brainOverride?.nextTurn ?? (async () => parseReporterLine(VALID)),
    };
    const logs: string[] = [];
    const orch = new SessionOrchestrator({
      stt,
      brain,
      tts,
      sink,
      scenario: cafeScenario,
      voiceId: "voice-1",
      log: (l) => logs.push(l),
    });
    await orch.start();
    return { stt, tts, messages, audio, orch, logs };
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
    expect(orch.currentState).toBe("thinking");
    orch.pushAudio(new Uint8Array([2]));
    releaseBrain(parseReporterLine(VALID));
    await tick();
    await tick();
    const allPushed = stt.sessions.flatMap((s) => s.pushed);
    expect(allPushed).toHaveLength(1);
    expect(orch.currentState).toBe("listening");
    // Listening again on the fresh session: pushes flow there.
    orch.pushAudio(new Uint8Array([3]));
    expect(stt.sessions[stt.sessions.length - 1]!.pushed).toHaveLength(1);
  });
});
