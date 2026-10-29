import { describe, expect, it, vi } from "vitest";
import { clientMessageSchema, estimatedSpeechMs, serverMessageSchema, stripAudioTags } from "@hot-seat/shared";
import { BROWSER_TTS_LABEL, loadConfig, providerStatuses } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { ElevenLabsTextToSpeech, guardedFetch } from "../src/providers/text-to-speech.js";
import { SessionOrchestrator, type ClientSink } from "../src/session/orchestrator.js";
import type { SpeechToText, SttSession } from "../src/providers/speech-to-text.js";
import { cafeProfileScenario, cafeScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionStore } from "../src/session/store.js";
import { debriefSchema } from "@hot-seat/shared";

describe("TTS_PROVIDER selection", () => {
  it("defaults to browser", () => { expect(loadConfig({}).ttsProvider).toBe("browser"); expect(loadConfig({}).TTS_PROVIDER).toBe("browser"); });
  it("elevenlabs without key falls back to browser with reason", () => { const c = loadConfig({ TTS_PROVIDER: "elevenlabs" }); expect(c.ttsProvider).toBe("browser"); expect(c.ttsFallbackReason).toContain("ELEVENLABS_API_KEY"); });
  it("elevenlabs with key stays elevenlabs", () => { const c = loadConfig({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" }); expect(c.ttsProvider).toBe("elevenlabs"); expect(c.ttsFallbackReason).toBeNull(); });
  it("provider status and health label browser mode", async () => {
    const s = providerStatuses(loadConfig({}));
    expect(s.find((p) => p.id === "text-to-speech")?.label).toBe(BROWSER_TTS_LABEL);
    const app = buildApp(loadConfig({ NODE_ENV: "test" }));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toMatchObject({ tts: BROWSER_TTS_LABEL, ttsProvider: "browser" });
    await app.close();
  });
  it("guard blocks ElevenLabs URL in browser mode", async () => {
    const spy = vi.fn(async () => new Response("x"));
    await expect(guardedFetch("browser", spy as never)("https://api.elevenlabs.io/v1/text-to-speech/x")).rejects.toThrow(/blocked/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("schemas with voice hints", () => {
  it("reporter_line/news/interrupt accept voiceHint and old messages still parse", () => {
    expect(serverMessageSchema.parse({ type: "reporter_line", line: { move: "follow_up", flags: [], say: "Hi?", quote_used: null }, voiceHint: { role: "reporter", temperament: "relentless", gender: "male" } }).type).toBe("reporter_line");
    expect(serverMessageSchema.parse({ type: "reporter_line", line: { move: "follow_up", flags: [], say: "Hi?", quote_used: null } }).type).toBe("reporter_line");
    expect(serverMessageSchema.parse({ type: "news_flash", text: "Flash", atSeconds: 1, voiceHint: { role: "radio" } }).type).toBe("news_flash");
    expect(clientMessageSchema.parse({ type: "speech_started", speechStartMs: 42 })).toEqual({ type: "speech_started", speechStartMs: 42 });
    expect(clientMessageSchema.parse({ type: "playback_done" })).toEqual({ type: "playback_done" });
    expect(clientMessageSchema.parse({ type: "speech_failed", reason: "no_start" })).toEqual({ type: "speech_failed", reason: "no_start" });
    expect(clientMessageSchema.parse({ type: "speech_failed", reason: "error" })).toEqual({ type: "speech_failed", reason: "error" });
    expect(clientMessageSchema.safeParse({ type: "speech_failed", reason: "timeout" }).success).toBe(false);
  });
  it("tag stripping and speech estimate", () => {
    expect(stripAudioTags("[sharply] Hello there.")).toBe("Hello there.");
    expect(estimatedSpeechMs("one two three four five six")).toBe(Math.round((6 / 2.6) * 1000));
  });
});

class FakeSession implements SttSession {
  push(): void {} end(): void {} close(): void {}
  onPartial(): void {}
  events(): AsyncIterable<never> { return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) }; }
}
class FakeStt implements SpeechToText {
  sessions = 0;
  async openSession(): Promise<SttSession> { this.sessions++; return new FakeSession(); }
  async *transcribe(): AsyncIterable<{ text: string; isFinal: boolean }> { yield { text: "", isFinal: true }; }
}

async function browserSession(scenario: typeof cafeScenario | typeof cafeTestScenario) {
  const fetchSpy = vi.fn(async () => { throw new Error("should not fetch"); });
  const tts = new ElevenLabsTextToSpeech({ apiKey: "test-key", defaultVoiceId: "v1", fetchFn: fetchSpy as never });
  const messages: unknown[] = []; const audio: Uint8Array[] = [];
  const sink: ClientSink = { send: (m) => messages.push(m), sendAudio: (c) => audio.push(c) };
  const stt = new FakeStt();
  const brain = { openingQuestion: async () => ({ move: "new_angle" as const, flags: [], say: "[sharply] When did you know?", quote_used: null }), nextTurn: async () => ({ move: "follow_up" as const, flags: [], say: "Next?", quote_used: null }) };
  const orch = new SessionOrchestrator({ stt, brain: brain as never, tts, ttsProvider: "browser", sink, scenario: scenario as never, voiceId: "v1", log: () => undefined });
  await orch.start();
  return { fetchSpy, messages, audio, orch, stt };
}

describe("browser mode full fake session (no ElevenLabs fetch)", () => {
  it("hot seat: sends voiceHint, no audio, playback_done opens STT", async () => {
    const { fetchSpy, messages, audio, orch, stt } = await browserSession(cafeTestScenario);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(audio).toHaveLength(0);
    const line = messages.find((m) => (m as { type: string }).type === "reporter_line") as { voiceHint?: unknown };
    expect(line.voiceHint).toEqual({ role: "reporter", temperament: "relentless", gender: "male" });
    await orch.playbackDone();
    expect(stt.sessions).toBe(1);
    expect(orch.currentState).toBe("listening");
    await orch.stop();
  });
  it("profile: same guard", async () => {
    const { fetchSpy, orch } = await browserSession(cafeProfileScenario as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    await orch.playbackDone(); await orch.stop();
  });
});

describe("news clip in browser mode", () => {
  it("returns soundbite WAV plus anchor texts, no anchor TTS", async () => {
    const store = new ScenarioStore(); const sessions = new SessionStore();
    const id = store.add(cafeTestScenario);
    sessions.put({ id, scenario: cafeTestScenario, startedAtMs: 0, turns: [{ role: "user", text: "We knew nothing about it at all", elapsedSeconds: 5, flags: [] }] });
    const debrief = debriefSchema.parse({ scores: { clarity: 1, accountability: 1, composure: 1, message_discipline: 1, empathy: 1 }, verdict: "v", best_moments: [], worst_moments: [], headline_quote: "q", front_page: { headline: "h", subhead: "s" }, landmines: [], one_thing_to_practice: "p", news: { soundbite: "We knew nothing about it", soundbite_turn: 1, channel: "Riverside Tonight", anchor_intro: "Good evening, tonight the cafe story.", anchor_outro: "More later tonight.", chyron: "Cafe owner speaks", ticker: ["a", "b", "c"] } });
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), { store, sessions, generateDebrief: async () => debrief, imageGen: null });
    await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 50; i++) { const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip` }); if (r.statusCode === 200) { body = r.json(); break; } await new Promise((r) => setTimeout(r, 5)); }
    expect(body).toMatchObject({ ttsMode: "browser", anchorIntro: "Good evening, tonight the cafe story.", anchorOutro: "More later tonight." });
    expect((body!.timeline as Array<{ part: string }>).map((p) => p.part)).toEqual(["intro", "soundbite", "outro"]);
    const audio = await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip/soundbite-audio` });
    expect(audio.statusCode).toBe(200); expect(audio.headers["content-type"]).toContain("audio/wav");
    await app.close();
  });
});
