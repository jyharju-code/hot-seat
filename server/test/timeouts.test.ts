import { describe, expect, it } from "vitest";
import { isTimeoutOrNetworkError, timeoutSignal } from "../src/providers/timeout.js";
import { MetaLlm } from "../src/providers/meta-llm.js";
import { BasetenLlm } from "../src/providers/baseten-llm.js";
import { MetaImageGen } from "../src/providers/image-gen.js";
import { ElevenLabsTextToSpeech } from "../src/providers/text-to-speech.js";
import { MuseSpeechToText } from "../src/providers/speech-to-text.js";
import { DebriefCoach, generateFrontPage } from "../src/debrief.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { CrisisDirector } from "../src/scenarios/director.js";

const sampleDebrief = {
  scores: { clarity: 70, accountability: 40, composure: 80, message_discipline: 55, empathy: 60 },
  verdict: "You stayed calm but dodged the key question.",
  best_moments: [{ t: "00:20", quote: "We pulled the pastries at once.", why: "Specific action." }],
  worst_moments: [{ t: "00:45", quote: "We knew nothing about it.", why: "Not true.", better: "We learned that morning." }],
  headline_quote: "We knew nothing about it.",
  front_page: { headline: "WE KNEW NOTHING, SAYS OWNER", subhead: "Cafe owner faces questions" },
  landmines: [{ id: "L1", status: "raised_and_fumbled" as const, comment: "You denied knowledge." }],
  one_thing_to_practice: "Say what you knew and when.",
};

/** Fake fetch that never resolves until its signal aborts. */
function neverFetch() {
  let calls = 0;
  const fn = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) { reject(new Error("fetch called without a signal")); return; }
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

describe("timeoutSignal", () => {
  it("aborts at its timeout and combines with a session signal", async () => {
    const s = timeoutSignal(20);
    await expect(new Promise((r) => { if (s.aborted) r(true); else s.addEventListener("abort", () => r(true)); })).resolves.toBe(true);
    expect(isTimeoutOrNetworkError(timeoutError())).toBe(true);
    expect(isTimeoutOrNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isTimeoutOrNetworkError(new Error("bad json"))).toBe(false);
  });
});

describe("providers abort at their timeout (fake fetch never resolves)", () => {
  it("MetaLlm chat", async () => {
    const { fn } = neverFetch();
    const llm = new MetaLlm({ apiKey: "k", fetchFn: fn, chatTimeoutMs: 30 });
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("MetaLlm structured (debrief path)", async () => {
    const { fn } = neverFetch();
    const llm = new MetaLlm({ apiKey: "k", fetchFn: fn, structuredTimeoutMs: 30 });
    await expect(llm.generateStructured({ prompt: "x", parse: (r) => r })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("MetaLlm structured per-call timeout overrides", async () => {
    const { fn } = neverFetch();
    const llm = new MetaLlm({ apiKey: "k", fetchFn: fn, structuredTimeoutMs: 60000 });
    await expect(llm.generateStructured({ prompt: "x", timeoutMs: 30, parse: (r) => r })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("BasetenLlm chat", async () => {
    const { fn } = neverFetch();
    const llm = new BasetenLlm({ apiKey: "k", fetchFn: fn, chatTimeoutMs: 30 });
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("MetaImageGen generation and edit", async () => {
    const a = neverFetch();
    await expect(new MetaImageGen({ apiKey: "k", fetchFn: a.fn, timeoutMs: 30 }).generateImage("x")).rejects.toMatchObject({ name: "TimeoutError" });
    const b = neverFetch();
    await expect(new MetaImageGen({ apiKey: "k", fetchFn: b.fn, timeoutMs: 30 }).editPhoto({ image: new Uint8Array([1]), mimeType: "image/jpeg", prompt: "x" })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("ElevenLabs TTS", async () => {
    const { fn } = neverFetch();
    const tts = new ElevenLabsTextToSpeech({ apiKey: "k", defaultVoiceId: "v", fetchFn: fn, timeoutMs: 30 });
    await expect(tts.synthesize("hello")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("combined session signal still aborts a model call", async () => {
    const { fn } = neverFetch();
    const llm = new MetaLlm({ apiKey: "k", fetchFn: fn, chatTimeoutMs: 60000 });
    const ctl = new AbortController();
    const p = llm.chat({ messages: [{ role: "user", content: "hi" }], signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toBeTruthy();
  });
  it("STT handshake times out when the socket never acks", async () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const fakeWs = {
      readyState: 0,
      on(ev: string, cb: (...a: unknown[]) => void) { const l = listeners.get(ev) ?? []; l.push(cb); listeners.set(ev, l); },
      off(ev: string, cb: (...a: unknown[]) => void) { listeners.set(ev, (listeners.get(ev) ?? []).filter((c) => c !== cb)); },
      once(ev: string, cb: (...a: unknown[]) => void) { this.on(ev, cb); },
      send() { /* never acks */ },
      close() { for (const cb of listeners.get("close") ?? []) cb(); },
    };
    const stt = new MuseSpeechToText({ apiKey: "k", handshakeTimeoutMs: 30, webSocketFactory: () => fakeWs as never });
    await expect(stt.openSession()).rejects.toThrow(/handshake timed out/);
  });
});

describe("debrief retry", () => {
  it("retries once on timeout and then fails cleanly", async () => {
    let calls = 0;
    const logs: string[] = [];
    const coach = new DebriefCoach({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async () => { calls += 1; throw timeoutError(); },
    } as never, "m", "medium", (l) => logs.push(l), 30);
    await expect(coach.generate(cafeTestScenario, [], "en")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(2);
    expect(logs.some((l) => /^\[debrief\] timeout after \d+ms, retrying$/.test(l))).toBe(true);
    // The retry log line carries no prompt text.
    expect(logs.find((l) => l.includes("retrying"))).not.toContain("chars=");
  });
  it("succeeds on the retry", async () => {
    let calls = 0;
    const coach = new DebriefCoach({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async (input: { parse: (r: unknown) => unknown }) => { calls += 1; if (calls === 1) throw new TypeError("fetch failed"); return input.parse(sampleDebrief); },
    } as never);
    await expect(coach.generate(cafeTestScenario, [], "en")).resolves.toMatchObject({ verdict: sampleDebrief.verdict });
    expect(calls).toBe(2);
  });
  it("does not retry a non-network error", async () => {
    let calls = 0;
    const coach = new DebriefCoach({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async () => { calls += 1; throw new Error("invalid JSON"); },
    } as never);
    await expect(coach.generate(cafeTestScenario, [], "en")).rejects.toThrow(/invalid JSON/);
    expect(calls).toBe(1);
  });
});

describe("scenario retry (brief 17b)", () => {
  it("retries once on timeout, logs the retry, then succeeds", async () => {
    let calls = 0;
    const logs: string[] = [];
    const director = new CrisisDirector({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async (input: { parse: (r: unknown) => unknown }) => { calls += 1; if (calls === 1) throw timeoutError(); return input.parse(cafeTestScenario); },
    } as never, undefined, undefined, 60_000, (l) => logs.push(l));
    await expect(director.generate("A cafe crisis description", "en")).resolves.toMatchObject({ company: { name: "Kettle & Crumb" } });
    expect(calls).toBe(2);
    expect(logs).toContain("[scenario] timeout, retrying");
  });
  it("does not retry a non-network error and fails after two timeouts", async () => {
    let calls = 0;
    const bad = new CrisisDirector({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async () => { calls += 1; throw new Error("invalid JSON"); },
    } as never);
    await expect(bad.generate("A cafe crisis description", "en")).rejects.toThrow(/invalid JSON/);
    expect(calls).toBe(1);
    let calls2 = 0;
    const slow = new CrisisDirector({
      chat: async () => { throw new Error("unused"); },
      generateStructured: async () => { calls2 += 1; throw timeoutError(); },
    } as never);
    await expect(slow.generate("A cafe crisis description", "en")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls2).toBe(2);
  });
});

describe("front page retry", () => {
  it("retries a timed-out step once before succeeding", async () => {
    let calls = 0;
    const logs: string[] = [];
    const out = await generateFrontPage({
      generateImage: async () => { calls += 1; if (calls === 1) throw timeoutError(); return { image: new Uint8Array([1]), mimeType: "image/webp" }; },
      editPhoto: async () => { throw new Error("unused"); },
    }, sampleDebrief as never, cafeTestScenario, null, { log: (l) => logs.push(l) });
    expect(calls).toBe(2);
    expect(out.step).not.toBe("html");
    expect(logs.some((l) => /^\[front-page\] timeout after \d+ms, retrying$/.test(l))).toBe(true);
  });
});
