import { describe, expect, it } from "vitest";
import { CONNECTION_HICCUP_MESSAGE, type ReporterLine, type ServerMessage } from "@hot-seat/shared";
import { cafeScenario } from "../src/scenarios/cafe.js";
import { RECOVERY_LINE, SessionOrchestrator, sanitizeErrorForLog, type ClientSink } from "../src/session/orchestrator.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";

const LINE: ReporterLine = { move: "follow_up", flags: [], say: "When did you know?", quote_used: null, owner_done: true };

class FakeSession implements SttSession {
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(): void { /* noop */ }
  end(): void { /* noop */ }
  close(): void { while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>); }
  onPartial(): void { /* noop */ }
  emit(ev: SttEvent): void { const w = this.waiters.shift(); if (w) w({ value: ev, done: false }); else this.queue.push(ev); }
  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    return { [Symbol.asyncIterator]: () => ({ next(): Promise<IteratorResult<SttEvent>> { const q = queue.shift(); if (q) return Promise.resolve({ value: q, done: false }); return new Promise((r) => waiters.push(r)); } }) };
  }
}
class FakeStt implements SpeechToText {
  sessions: FakeSession[] = [];
  async openSession(): Promise<SttSession> { const s = new FakeSession(); this.sessions.push(s); return s; }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> { yield { text: "", isFinal: true }; }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: { tts: TextToSpeech; nextTurn: (answer: string) => Promise<ReporterLine>; logs?: string[]; turnCapMs?: number; turnEndSilenceMs?: number; turnEndHesitantMs?: number }) {
  const stt = new FakeStt();
  const messages: ServerMessage[] = [];
  const audio: Uint8Array[] = [];
  const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: (c) => audio.push(c) };
  const brain = { openingQuestion: async () => LINE, nextTurn: async (_s: unknown, _h: unknown, a: string) => opts.nextTurn(a), lastRaceWinner: null as null };
  const orch = new SessionOrchestrator({
    stt, brain: brain as never, tts: opts.tts, sink, scenario: cafeScenario, voiceId: "v1",
    turnEndSilenceMs: opts.turnEndSilenceMs ?? 0, turnEndHesitantMs: opts.turnEndHesitantMs ?? 0, ...(opts.turnCapMs !== undefined ? { turnCapMs: opts.turnCapMs } : {}), log: (l) => opts.logs?.push(l), errorLog: (l) => opts.logs?.push(l),
  });
  return { stt, messages, audio, orch };
}

async function driveAnswer(stt: FakeStt) {
  stt.sessions[0]!.emit({ type: "final", text: "We closed the cafe that morning and told every customer directly today." });
  await wait(30);
}

describe("failure recovery (brief 11)", () => {
  it("sanitizes URLs and keys for logs, keeping cause text", () => {
    const err = new Error("fetch failed https://api.example.com/v1/tts?api_key=secret123&x=1");
    const out = sanitizeErrorForLog(err);
    expect(out).toContain("https://api.example.com/v1/tts");
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("x=1");
  });

  it("TTS fails once then succeeds: one retry, line is spoken", async () => {
    let failuresLeft = 0;
    const tts: TextToSpeech = {
      async *synthesize() {
        if (failuresLeft > 0) { failuresLeft -= 1; throw new Error("fetch failed"); }
        yield new Uint8Array([1, 0]);
      },
    };
    const { stt, messages, audio, orch } = setup({ tts, nextTurn: async () => LINE });
    await orch.start(); await orch.playbackDone();
    failuresLeft = 1;
    const before = audio.length;
    await driveAnswer(stt);
    expect(failuresLeft).toBe(0);
    expect(audio.length).toBeGreaterThan(before);
    expect(messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === LINE.say)).toBe(true);
    expect(orch.currentState).toBe("speaking");
    await orch.stop();
  });

  it("TTS fails twice: recovery line shown, hiccup not raw error, back to listening when TTS down", async () => {
    let down = false;
    const tts: TextToSpeech = {
      async *synthesize() {
        if (down) throw new Error("fetch failed");
        yield new Uint8Array([1, 0]);
      },
    };
    const logs: string[] = [];
    const { stt, messages, orch } = setup({ tts, nextTurn: async () => LINE, logs });
    await orch.start(); await orch.playbackDone();
    down = true;
    await driveAnswer(stt);
    await wait(20);
    expect(messages.some((m) => m.type === "error" && m.message === CONNECTION_HICCUP_MESSAGE)).toBe(true);
    expect(messages.some((m) => m.type === "error" && m.message.includes("fetch failed"))).toBe(false);
    expect(messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === RECOVERY_LINE)).toBe(true);
    expect(logs.some((l) => l.includes("[error] stage=tts"))).toBe(true);
    // TTS is down, so the recovery text is shown and we are listening again.
    expect(orch.currentState).toBe("listening");
    await orch.stop();
  });

  it("turn LLM fails once then succeeds on the fresh retry", async () => {
    let attempts = 0;
    const tts: TextToSpeech = { async *synthesize() { yield new Uint8Array([1, 0]); } };
    const { stt, messages, orch } = setup({
      tts,
      nextTurn: async () => { attempts += 1; if (attempts === 1) throw new Error("fetch failed"); return LINE; },
    });
    await orch.start(); await orch.playbackDone();
    await driveAnswer(stt);
    expect(attempts).toBe(2);
    expect(messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === LINE.say)).toBe(true);
    expect(["speaking", "listening"]).toContain(orch.currentState);
    await orch.stop();
  });

  it("cap: turn ends at turnCapMs even when owner_done is false and hesitant window is long", async () => {
    const tts: TextToSpeech = { async *synthesize() { yield new Uint8Array([1, 0]); } };
    const { stt, messages, orch } = setup({
      tts,
      nextTurn: async () => ({ ...LINE, owner_done: false }),
      turnEndSilenceMs: 1000, turnEndHesitantMs: 5000, turnCapMs: 150,
    });
    await orch.start(); await orch.playbackDone();
    const t0 = Date.now();
    stt.sessions[0]!.emit({ type: "final", text: "We closed the cafe that morning and told every customer directly today." });
    await wait(400);
    expect(messages.some((m) => m.type === "transcript" && m.role === "user")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(["speaking", "listening"]).toContain(orch.currentState);
    await orch.stop();
  });

  it("turn LLM always fails: recovery line is spoken and state advances", async () => {
    const tts: TextToSpeech = { async *synthesize() { yield new Uint8Array([1, 0]); } };
    const { stt, messages, orch } = setup({ tts, nextTurn: async () => { throw new Error("fetch failed"); } });
    await orch.start(); await orch.playbackDone();
    await driveAnswer(stt);
    await wait(20);
    expect(messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === RECOVERY_LINE)).toBe(true);
    expect(messages.some((m) => m.type === "error" && m.message === CONNECTION_HICCUP_MESSAGE)).toBe(true);
    expect(orch.currentState).toBe("speaking");
    await orch.playbackDone();
    expect(orch.currentState).toBe("listening");
    await orch.stop();
  });
});
