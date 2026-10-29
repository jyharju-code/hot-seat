import { describe, expect, it, vi } from "vitest";
import {
  generatedScenarioSchema,
  isSessionComplete,
  profilePhase,
  serverMessageSchema,
  shouldWrapUp,
  type ReporterLine,
  type ServerMessage,
} from "@hot-seat/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildFrontPagePrompt, DebriefCoach, debriefLandmineInputs } from "../src/debrief.js";
import { JournalistBrain, loadJournalistPrompts, parseReporterLine } from "../src/journalist.js";
import { cafeProfileScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { normalizeProfileScenario } from "../src/scenarios/director.js";
import { profilePresets, presets } from "../src/scenarios/presets.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionOrchestrator, MAX_SESSION_MS, PROFILE_COMPLETE_MESSAGE, finalProfileMessage, isThankYouOrGoodbyeLine, type ClientSink } from "../src/session/orchestrator.js";
import { PROFILE_CUT_IN_MESSAGE, PROFILE_WRAP_UP_LINE } from "@hot-seat/shared";
import { SessionStore, formatHarvestedQuotes, harvestedQuotes } from "../src/session/store.js";
import type { SpeechToText, SttEvent, SttSession } from "../src/providers/speech-to-text.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";
import { estimateTotalChars, parseArgs } from "../scripts/sim/main.js";
const sampleDebrief = {
  scores: { clarity: 70, accountability: 40, composure: 80, message_discipline: 55, empathy: 60 },
  verdict: "You stayed calm. The paper will quote the warm slip.",
  best_moments: [{ t: "00:20", quote: "We parted ways and I wish him well.", why: "Warm and safe." }],
  worst_moments: [{ t: "00:45", quote: "Honestly, my old partner nearly killed this place", why: "Blame in print.", better: "We parted ways and I wish him well." }],
  headline_quote: "Honestly, my old partner nearly killed this place",
  front_page: { headline: "NEARLY KILLED THIS PLACE", subhead: "Owner looks back on ten years" },
  landmines: [{ id: "L1", status: "raised_and_fumbled" as const, comment: "Let it slip." }],
  one_thing_to_practice: "Enjoy the compliment, then answer as if none was paid.",
};

describe("profile format and duration parse", () => {
  it("parses profile with duration 5 and 10", () => {
    expect(generatedScenarioSchema.parse(cafeProfileScenario).format).toBe("profile");
    expect(generatedScenarioSchema.parse({ ...cafeProfileScenario, duration_minutes: 10 }).duration_minutes).toBe(10);
    expect(() => generatedScenarioSchema.parse({ ...cafeProfileScenario, duration_minutes: 7 })).toThrow();
    expect(() => generatedScenarioSchema.parse({ ...cafeProfileScenario, format: "town_hall" })).toThrow();
  });
  it("old scenarios still load (no format profile, no duration_minutes)", () => {
    const raw = JSON.parse(JSON.stringify(cafeTestScenario)) as Record<string, unknown>;
    delete raw.duration_minutes;
    const parsed = generatedScenarioSchema.parse(raw);
    expect(parsed.format).toBe("interview");
    expect(parsed.duration_minutes).toBe(5);
  });
  it("normalize forces all sensitivities owner_knows, reporter knows none, no escalations, human voice", () => {
    const messy = { ...cafeTestScenario, format: "profile" as const, escalations: cafeTestScenario.escalations };
    const n = normalizeProfileScenario(messy, 10);
    expect(n.duration_minutes).toBe(10);
    expect(n.escalations).toEqual([]);
    expect(n.landmines.every((m) => m.owner_knows && m.who_knows === "none")).toBe(true);
    expect(n.journalists[0]!.temperament).toBe("human");
  });
  it("ships six profile presets, one line each, distinct from crisis presets", () => {
    expect(profilePresets).toHaveLength(6);
    expect(profilePresets.every((p) => p.mode === "profile")).toBe(true);
    expect(presets).toHaveLength(6);
  });
});

describe("profile timing helpers", () => {
  it("wraps up at duration minus 45s and completes at duration", () => {
    expect(profilePhase(254, 300)).toBe("running");
    expect(shouldWrapUp(255, 300)).toBe(true);
    expect(shouldWrapUp(299, 300)).toBe(true);
    expect(isSessionComplete(300, 300)).toBe(true);
    expect(isSessionComplete(299, 300)).toBe(false);
    expect(profilePhase(555, 600)).toBe("wrapping_up");
  });
  it("MAX_SESSION_MS allows 10 minutes plus margin", () => {
    expect(MAX_SESSION_MS).toBeGreaterThan(600_000);
  });
  it("session_complete is a valid server message", () => {
    expect(serverMessageSchema.parse({ type: "session_complete", message: "Thanks" }).type).toBe("session_complete");
  });
});

describe("profile reporter line", () => {
  it("parses quote_harvest and angle, keeps owner_done", () => {
    const line = parseReporterLine(JSON.stringify({ move: "follow_up", flags: [], say: "Tell me more.", quote_used: null, owner_done: true, quote_harvest: "my old partner nearly killed this place", angle: "falling-out" }));
    expect(line.quote_harvest).toContain("nearly killed");
    expect(line.angle).toBe("falling-out");
  });
  it("profile brain uses profile prompt with elapsed/duration and never gives sensitivities to reporter", async () => {
    const prompts = await loadJournalistPrompts();
    expect(prompts.profileTurn).toContain("quote_harvest");
    expect(prompts.profileTurn).toContain("Never confront");
    let lastPrompt = "";
    const brain = new JournalistBrain({
      chat: async (input: { messages?: Array<{ content: string }> }) => { lastPrompt = input.messages?.[0]?.content ?? ""; return { text: JSON.stringify({ move: "follow_up", flags: [], say: "Oh, tell me more about that.", quote_used: null, owner_done: true, quote_harvest: null, angle: null }), model: "m", finishReason: "stop" }; },
      generateStructured: async () => { throw new Error("unused"); },
    } as never, prompts);
    await brain.nextTurn(cafeProfileScenario, [{ role: "user", text: "hi" }], "hi", 260, undefined, []);
    expect(lastPrompt).toContain("Elapsed seconds: 260");
    expect(lastPrompt).toContain("Total session seconds: 300");
    expect(lastPrompt).not.toContain("nearly killed this place");
    expect(lastPrompt).not.toContain("{elapsed_seconds}");
  });
});

class FakeSession implements SttSession {
  pushed: Uint8Array[] = [];
  closed = false;
  private queue: SttEvent[] = [];
  private waiters: Array<(v: IteratorResult<SttEvent>) => void> = [];
  push(pcm: Uint8Array): void { this.pushed.push(pcm); }
  end(): void {}
  close(): void { this.closed = true; while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true } as IteratorResult<SttEvent>); }
  onPartial(): void {}
  emit(ev: SttEvent): void { const w = this.waiters.shift(); if (w) w({ value: ev, done: false }); else this.queue.push(ev); }
  events(): AsyncIterable<SttEvent> { const { queue, waiters } = this; return { [Symbol.asyncIterator]: () => ({ next: (): Promise<IteratorResult<SttEvent>> => { const q = queue.shift(); if (q) return Promise.resolve({ value: q, done: false }); if (this.closed) return Promise.resolve({ value: undefined, done: true } as IteratorResult<SttEvent>); return new Promise((r) => waiters.push(r)); } }) }; }
}
class FakeStt implements SpeechToText {
  sessions: FakeSession[] = [];
  async openSession(): Promise<SttSession> { const s = new FakeSession(); this.sessions.push(s); return s; }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> { yield { text: "", isFinal: true }; }
}
class FakeTts implements TextToSpeech {
  async *synthesize(): AsyncIterable<Uint8Array> { yield new Uint8Array([1]); }
}

describe("profile orchestrator", () => {
  it("fires session_complete at duration, not ended, and disables interrupts/escalations", async () => {
    vi.useFakeTimers();
    try {
      const messages: ServerMessage[] = [];
      const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
      let deciderCalls = 0;
      const brain = {
        openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
        nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Tell me more.", quote_used: null, quote_harvest: "Honestly, my old partner nearly killed this place", angle: "feud" }),
      };
      const record = { id: "s1", scenario: cafeProfileScenario, startedAtMs: 0, turns: [] as never[] };
      const orch = new SessionOrchestrator({
        stt: new FakeStt(), brain: brain as never, tts: new FakeTts(), sink,
        scenario: cafeProfileScenario, voiceId: "v1", record: record as never,
        turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
        interruptDecider: { decide: async () => { deciderCalls += 1; return { interrupt: true, reason: "x", say: "cut" }; } },
        interruptsEnabled: true,
      });
      await orch.start();
      await vi.advanceTimersByTimeAsync(299_000);
      expect(messages.some((m) => m.type === "session_complete")).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(messages.some((m) => m.type === "session_complete")).toBe(true);
      expect(deciderCalls).toBe(0);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("wrap-up: owner speaking at wrap-up moment, next reporter line is the wrap-up question", async () => {
    vi.useFakeTimers();
    try {
      const messages: ServerMessage[] = [];
      const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
      const stt = new FakeStt();
      const brain = {
        openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
        nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Lovely, tell me more about the early days.", quote_used: null }),
      };
      const record = { id: "s-wrap1", scenario: cafeProfileScenario, startedAtMs: 0, turns: [] as never[] };
      const orch = new SessionOrchestrator({
        stt, brain: brain as never, tts: new FakeTts(), ttsProvider: "browser", sink,
        scenario: cafeProfileScenario, voiceId: "v1", record: record as never,
        turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
      });
      await orch.start();
      await orch.playbackDone();
      stt.sessions[0]!.emit({ type: "partial", text: "We opened ten years ago and I have a very long story about those early days and I keep talking" });
      await vi.advanceTimersByTimeAsync(255_000);
      expect(orch.isOwnerSpeaking).toBe(true);
      expect(orch.isWrapUpDue).toBe(true);
      stt.sessions[0]!.emit({ type: "final", text: "We opened ten years ago.", turnId: "t1" });
      await vi.advanceTimersByTimeAsync(1_000);
      const reporterTexts = messages.filter((m) => m.type === "transcript" && m.role === "reporter").map((m) => (m as { text: string }).text);
      expect(reporterTexts).toContain(PROFILE_WRAP_UP_LINE);
      expect(reporterTexts).not.toContain("Lovely, tell me more about the early days.");
      expect(orch.isWrapUpSpoken).toBe(true);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("wrap-up: no next line before the end, final thank-you is the warm cut-in", async () => {
    vi.useFakeTimers();
    try {
      const messages: ServerMessage[] = [];
      const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
      const stt = new FakeStt();
      const brain = {
        openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
        nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Lovely, tell me more.", quote_used: null }),
      };
      const record = { id: "s-wrap2", scenario: cafeProfileScenario, startedAtMs: 0, turns: [] as never[] };
      const orch = new SessionOrchestrator({
        stt, brain: brain as never, tts: new FakeTts(), ttsProvider: "browser", sink,
        scenario: cafeProfileScenario, voiceId: "v1", record: record as never,
        turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
      });
      await orch.start();
      await orch.playbackDone();
      stt.sessions[0]!.emit({ type: "partial", text: "I am still telling a very long story about the early days and I have not finished at all" });
      await vi.advanceTimersByTimeAsync(300_000);
      const complete = messages.find((m) => m.type === "session_complete") as { message: string; voiceHint?: unknown } | undefined;
      expect(complete?.message).toBe(PROFILE_CUT_IN_MESSAGE);
      expect(complete?.voiceHint).toEqual({ role: "reporter", temperament: "human", gender: cafeProfileScenario.journalists[0]!.voice });
      const reporterTexts = messages.filter((m) => m.type === "transcript" && m.role === "reporter").map((m) => (m as { text: string }).text);
      expect(reporterTexts).not.toContain(PROFILE_WRAP_UP_LINE);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("profile ending: not mid-answer, session_complete carries the normal thank-you and reporter voice hint", async () => {
    vi.useFakeTimers();
    try {
      const messages: ServerMessage[] = [];
      const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
      const brain = {
        openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
        nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Tell me more.", quote_used: null }),
      };
      const record = { id: "s-wrap3", scenario: cafeProfileScenario, startedAtMs: 0, turns: [] as never[] };
      const orch = new SessionOrchestrator({
        stt: new FakeStt(), brain: brain as never, tts: new FakeTts(), ttsProvider: "browser", sink,
        scenario: cafeProfileScenario, voiceId: "v1", record: record as never,
        turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
      });
      await orch.start();
      await vi.advanceTimersByTimeAsync(300_000);
      const complete = messages.find((m) => m.type === "session_complete") as { message: string; voiceHint?: unknown } | undefined;
      expect(complete?.message).toBe(PROFILE_COMPLETE_MESSAGE);
      expect(complete?.voiceHint).toBeTruthy();
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("profile ending: goodbye before wrap-up is rejected, final line stays the full thank-you (17b)", async () => {
    expect(isThankYouOrGoodbyeLine("Thank you so much, this has been such a pleasure.")).toBe(true);
    expect(isThankYouOrGoodbyeLine("Goodbye for now.")).toBe(true);
    expect(isThankYouOrGoodbyeLine("Thanks a lot.")).toBe(true);
    expect(isThankYouOrGoodbyeLine("Tell me more about the early days.")).toBe(false);
    expect(finalProfileMessage("Thank you so much, this has been such a pleasure.", false)).toBe("Thank you again.");
    expect(finalProfileMessage("Tell me more.", false)).toBe(PROFILE_COMPLETE_MESSAGE);
    expect(finalProfileMessage("Tell me more.", true)).toBe(PROFILE_CUT_IN_MESSAGE);
    expect(finalProfileMessage("Thank you so much.", true)).toBe("Thank you again.");
    vi.useFakeTimers();
    try {
      const messages: ServerMessage[] = [];
      const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
      const stt = new FakeStt();
      const brain = {
        openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
        nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Thank you so much, this has been such a pleasure.", quote_used: null }),
      };
      const record = { id: "s-thanks", scenario: cafeProfileScenario, startedAtMs: 0, turns: [] as never[] };
      const orch = new SessionOrchestrator({
        stt, brain: brain as never, tts: new FakeTts(), ttsProvider: "browser", sink,
        scenario: cafeProfileScenario, voiceId: "v1", record: record as never,
        turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
      });
      await orch.start();
      await orch.playbackDone();
      stt.sessions[0]!.emit({ type: "final", text: "We opened ten years ago.", turnId: "t1" });
      await vi.advanceTimersByTimeAsync(1_000);
      const reporterTexts = messages.filter((m) => m.type === "transcript" && m.role === "reporter").map((m) => (m as { text: string }).text);
      // Brief 17b: a goodbye before wrap-up time is rejected like a repeat.
      expect(reporterTexts).not.toContain("Thank you so much, this has been such a pleasure.");
      await vi.advanceTimersByTimeAsync(300_000);
      const complete = messages.find((m) => m.type === "session_complete") as { message: string } | undefined;
      expect(complete?.message).toBe(PROFILE_COMPLETE_MESSAGE);
      await orch.stop();
    } finally { vi.useRealTimers(); }
  });

  it("brief 17b: hot seat close beat ends the session with session_complete, close line as message", async () => {
    const messages: ServerMessage[] = [];
    const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
    const stt = new FakeStt();
    const closeSay = "Thank you for speaking to me. I will put all of that to our readers today.";
    const brain = {
      openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "When did it break?", quote_used: null, beat_id: "facts" }),
      nextTurn: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: closeSay, quote_used: null, beat_id: "close" }),
    };
    const record = { id: "s-hotclose", scenario: cafeTestScenario, startedAtMs: 0, turns: [] as never[] };
    let ended = 0;
    const orch = new SessionOrchestrator({
      stt, brain: brain as never, tts: new FakeTts(), ttsProvider: "browser", sink,
      scenario: cafeTestScenario, voiceId: "v1", record: record as never,
      turnEndSilenceMs: 0, turnEndHesitantMs: 0, listenIdleMs: 600_000, maxSessionMs: 720_000,
      onSessionEnded: () => { ended += 1; },
    });
    await orch.start();
    await orch.playbackDone();
    stt.sessions[0]!.emit({ type: "final", text: "We pulled the pastries at once.", turnId: "t1" });
    const t0 = Date.now();
    while (!messages.some((m) => m.type === "session_complete")) {
      if (Date.now() - t0 > 3000) throw new Error("session_complete timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
    const complete = messages.find((m) => m.type === "session_complete") as { message: string } | undefined;
    expect(complete?.message).toBe(closeSay);
    expect(messages.filter((m) => m.type === "session_complete")).toHaveLength(1);
    expect(ended).toBe(1);
    await orch.stop();
  });

  it("a profile turn fires no escalation and no interrupt even when one is due and a decider says yes", async () => {
    const messages: ServerMessage[] = [];
    const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: () => undefined };
    const stt = new FakeStt();
    let deciderCalls = 0;
    const scenario = { ...cafeProfileScenario, escalations: [{ at_seconds: 0, news_flash: "BREAKING", gives_journalist: "J1", new_fact: "x" }] };
    const brain = {
      openingQuestion: async (): Promise<ReporterLine> => ({ move: "new_angle", flags: [], say: "Tell me your story.", quote_used: null }),
      nextTurn: async (): Promise<ReporterLine> => ({ move: "follow_up", flags: [], say: "Lovely, tell me more.", quote_used: null, quote_harvest: "a quotable line", angle: "story" }),
    };
    const record = { id: "s2", scenario, startedAtMs: 0, turns: [] as Array<Record<string, unknown>> };
    const orch = new SessionOrchestrator({
      stt, brain: brain as never, tts: new FakeTts(), sink, scenario, voiceId: "v1",
      record: record as never, turnEndSilenceMs: 0, turnEndHesitantMs: 0,
      interruptDecider: { decide: async () => { deciderCalls += 1; return { interrupt: true, reason: "x", say: "cut in" }; } },
      interruptsEnabled: true, interruptAfterMs: 0,
    });
    await orch.start();
    await orch.playbackDone();
    stt.sessions[0]!.emit({ type: "partial", text: "We opened ten years ago and my old partner nearly killed this place and I keep talking" });
    stt.sessions[0]!.emit({ type: "final", text: "We opened ten years ago.", turnId: "t1" });
    const t0 = Date.now();
    while (!messages.some((m) => m.type === "transcript" && m.role === "reporter" && m.text === "Lovely, tell me more.")) {
      if (Date.now() - t0 > 3000) throw new Error("reporter reply timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(messages.some((m) => m.type === "news_flash")).toBe(false);
    expect(messages.some((m) => m.type === "interrupt")).toBe(false);
    expect(deciderCalls).toBe(0);
    expect(record.turns.some((t) => t.role === "reporter" && t.quoteHarvest === "a quotable line")).toBe(true);
    // Hidden from the client: reporter_line carries no harvest.
    const lineMsg = messages.find((m) => m.type === "reporter_line" && m.line.say === "Lovely, tell me more.");
    expect(lineMsg && "line" in lineMsg ? lineMsg.line.quote_harvest : "missing").toBeUndefined();
    await orch.stop();
  });

  it("harvested quotes are recorded hidden and reach the debrief input", async () => {
    const turns = [
      { role: "reporter" as const, text: "Tell me more.", elapsedSeconds: 30, flags: [], quoteHarvest: "Honestly, my old partner nearly killed this place", angle: "feud" },
      { role: "user" as const, text: "Honestly, my old partner nearly killed this place", elapsedSeconds: 25, flags: [] },
    ];
    expect(harvestedQuotes(turns)).toEqual(["Honestly, my old partner nearly killed this place"]);
    expect(formatHarvestedQuotes(turns)).toContain("nearly killed");
    let prompt = "";
    const coach = new DebriefCoach({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async (input: { prompt: string; parse: (r: unknown) => unknown }) => { prompt = input.prompt; return input.parse({ ...sampleDebrief, gave_away: [{ quote: "Honestly, my old partner nearly killed this place", framing: "feud headline", better: "We parted ways and I wish him well." }] }); },
    } as never);
    const out = await coach.generate(cafeProfileScenario, turns, "en");
    expect(prompt).toContain("Mode: profile");
    expect(prompt).toContain("nearly killed this place");
    expect(prompt).toContain('"revealed_to_reporter":false');
    expect(out.gave_away?.[0]!.quote).toContain("nearly killed");
    expect(debriefLandmineInputs(cafeProfileScenario, 9999).every((i) => !i.revealed_to_reporter)).toBe(true);
  });

  it("profile front page is a friendly feature page built from the damaging quote", async () => {
    const prompt = await buildFrontPagePrompt({ ...sampleDebrief, headline_quote: "Honestly, my old partner nearly killed this place" } as never, cafeProfileScenario, false, "Friday 30 October 2026");
    expect(prompt).toContain("friendly local newspaper feature page");
    expect(prompt).toContain("nearly killed this place");
    expect(prompt).toContain("friendly feature page, not a crisis page");
    expect(prompt).toContain("smiling owner");
  });
});

describe("profile API and sim", () => {
  it("POST /api/scenarios passes mode and duration to the generator and validates them", async () => {
    let seen: unknown;
    const store = new ScenarioStore();
    const sessions = new SessionStore();
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      store, sessions,
      generateScenario: async (_d, _l, opts) => { seen = opts; return cafeProfileScenario; },
    });
    const ok = await app.inject({ method: "POST", url: "/api/scenarios", payload: { description: "My café is ten years old this month.", language: "en", mode: "profile", duration_minutes: 10 } });
    expect(ok.statusCode).toBe(200);
    expect(seen).toEqual({ mode: "profile", durationMinutes: 10 });
    expect(ok.json().scenario.format).toBe("profile");
    const badMode = await app.inject({ method: "POST", url: "/api/scenarios", payload: { description: "My café is ten years old this month.", language: "en", mode: "chatty" } });
    expect(badMode.statusCode).toBe(400);
    const badDur = await app.inject({ method: "POST", url: "/api/scenarios", payload: { description: "My café is ten years old this month.", language: "en", mode: "profile", duration_minutes: 7 } });
    expect(badDur.statusCode).toBe(400);
    const presetsRes = await app.inject({ method: "GET", url: "/api/presets" });
    expect(presetsRes.json().profilePresets).toHaveLength(6);
    expect(presetsRes.json().presets).toHaveLength(6);
    await app.close();
  });
  it("sim parses --mode profile --duration 5 and estimates more chars", () => {
    const args = parseArgs(["--mode", "profile", "--duration", "5"]);
    expect(args.mode).toBe("profile");
    expect(args.duration).toBe(5);
    expect(estimateTotalChars(1, 4, "profile", 5)).toBe(10 * 900);
    expect(estimateTotalChars(1, 4, "profile", 5)).toBeGreaterThan(estimateTotalChars(1, 4));
    expect(() => parseArgs(["--duration", "7"])).toThrow();
    expect(() => parseArgs(["--mode", "chatty"])).toThrow();
  });
});
