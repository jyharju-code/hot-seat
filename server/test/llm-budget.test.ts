import { describe, expect, it } from "vitest";
import { JournalistBrain, type JournalistPrompts } from "../src/journalist.js";
import { LlmInterruptDecider } from "../src/interrupt.js";
import { MIN_REASONING_MAX_TOKENS, type Llm, type LlmChatInput, type LlmChatResult, type LlmStructuredInput } from "../src/providers/llm.js";
import { CrisisDirector } from "../src/scenarios/director.js";
import { DebriefCoach } from "../src/debrief.js";
import { cafeScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { SessionOrchestrator } from "../src/session/orchestrator.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";

const VALID = JSON.stringify({ move: "follow_up", flags: [], say: "When did you know?", quote_used: null });
const PROMPTS: JournalistPrompts = { spokenStyle: "STYLE", journalistTurn: "T {last_answer} {spoken_style}", openingQuestion: "O" };

class RecordingLlm implements Llm {
  chatInputs: LlmChatInput[] = [];
  structuredInputs: Array<LlmStructuredInput<unknown>> = [];
  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    this.chatInputs.push(input);
    const prompt = input.messages[0]?.content ?? "";
    const text = prompt.startsWith("interrupt:")
      ? JSON.stringify({ interrupt: false, reason: "ok", say: "" })
      : VALID;
    return { text, model: "fake", finishReason: "stop" };
  }
  async generateStructured<T>(input: LlmStructuredInput<T>): Promise<T> {
    this.structuredInputs.push(input as LlmStructuredInput<unknown>);
    return cafeTestScenario as T;
  }
}

class FakeSession implements SttSession {
  pushed: Uint8Array[] = [];
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(pcm: Uint8Array): void { this.pushed.push(pcm); }
  end(): void {}
  close(): void { while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>); }
  onPartial(_cb: (t: string) => void): void {}
  emit(ev: SttEvent): void { const w = this.waiters.shift(); if (w) w({ value: ev, done: false }); else this.queue.push(ev); }
  events(): AsyncIterable<SttEvent> {
    const { queue, waiters } = this;
    return { [Symbol.asyncIterator]: () => ({ next(): Promise<IteratorResult<SttEvent>> {
      const q = queue.shift();
      if (q) return Promise.resolve({ value: q, done: false });
      return new Promise((r) => waiters.push(r));
    } }) };
  }
}
class FakeStt implements SpeechToText {
  sessions: FakeSession[] = [];
  async openSession(): Promise<SttSession> { const s = new FakeSession(); this.sessions.push(s); return s; }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> { yield { text: "", isFinal: true }; }
}
class FakeTts implements TextToSpeech {
  async *synthesize(): AsyncIterable<Uint8Array> { yield new Uint8Array([1, 0]); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reasoning model token budgets", () => {
  it("constant is at least 1500", () => {
    expect(MIN_REASONING_MAX_TOKENS).toBeGreaterThanOrEqual(1500);
  });

  it("every LLM call site passes at least the minimum budget", async () => {
    // turn
    const turnLlm = new RecordingLlm();
    await new JournalistBrain(turnLlm, PROMPTS).nextTurn(cafeScenario, [], "We fixed it.");
    expect(turnLlm.chatInputs).toHaveLength(1);
    expect(turnLlm.chatInputs[0]!.maxTokens).toBeGreaterThanOrEqual(MIN_REASONING_MAX_TOKENS);

    // speculative turn: orchestrator starts the brain on the first final
    const specLlm = new RecordingLlm();
    const stt = new FakeStt();
    const orch = new SessionOrchestrator({
      stt, brain: new JournalistBrain(specLlm, PROMPTS), tts: new FakeTts(),
      sink: { send: () => {}, sendAudio: () => {} },
      scenario: cafeTestScenario, voiceId: "voice-1", turnEndSilenceMs: 100, turnEndHesitantMs: 100,
    });
    await orch.start();
    await orch.playbackDone();
    specLlm.chatInputs = [];
    stt.sessions[0]!.emit({ type: "final", text: "We fixed it." });
    await wait(20);
    expect(specLlm.chatInputs.length).toBeGreaterThanOrEqual(1);
    for (const c of specLlm.chatInputs) expect(c.maxTokens).toBeGreaterThanOrEqual(MIN_REASONING_MAX_TOKENS);
    await wait(300);
    await orch.stop();

    // interrupt
    const intLlm = new RecordingLlm();
    const decider = new LlmInterruptDecider(intLlm, "interrupt: {partial}", "turn-model");
    await decider.decide({ name: "W", outlet: "C", question: "Q?", seconds: 9, partial: "rambling", facts: "f" });
    expect(intLlm.chatInputs[0]!.maxTokens).toBeGreaterThanOrEqual(MIN_REASONING_MAX_TOKENS);

    // scenario (structured)
    const scenLlm = new RecordingLlm();
    await new CrisisDirector(scenLlm).generate("A cafe crisis description long enough", "en");
    expect(scenLlm.structuredInputs).toHaveLength(1);
    expect(scenLlm.structuredInputs[0]!.maxTokens).toBeGreaterThanOrEqual(MIN_REASONING_MAX_TOKENS);

    // debrief (structured)
    const debLlm = new RecordingLlm();
    await new DebriefCoach(debLlm).generate(cafeTestScenario, [], "en");
    expect(debLlm.structuredInputs).toHaveLength(1);
    expect(debLlm.structuredInputs[0]!.maxTokens).toBeGreaterThanOrEqual(MIN_REASONING_MAX_TOKENS);
  });
});
