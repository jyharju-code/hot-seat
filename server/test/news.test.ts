import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { debriefSchema } from "@hot-seat/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionStore } from "../src/session/store.js";
import { getOrCreateOwnerAudio, ownerAudioRegistry } from "../src/session/owner-audio.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";
import type { ImageGen } from "../src/providers/image-gen.js";
import {
  buildWordTimes,
  computeCut,
  extractWordTimings,
  fuzzyFindQuote,
  snapCut,
} from "../src/news/soundbite.js";
import { assembleClip, buildTimeline, encodeWav } from "../src/news/clip.js";
import { locateSoundbite } from "../src/news/build-clip.js";

const sampleDebrief = {
  scores: { clarity: 70, accountability: 40, composure: 80, message_discipline: 55, empathy: 60 },
  verdict: "You stayed calm but dodged the key question. The paper will quote the dodge.",
  best_moments: [{ t: "00:20", quote: "We pulled the pastries at once.", why: "Specific action." }],
  worst_moments: [
    {
      t: "00:45",
      quote: "We knew nothing about it.",
      why: "It was not true on your own timeline.",
      better: "We learned about the crack that morning and acted too slowly.",
    },
  ],
  headline_quote: "We knew nothing about it.",
  front_page: { headline: "WE KNEW NOTHING, SAYS OWNER", subhead: "Cafe owner faces questions over cracked case" },
  landmines: [{ id: "L1", status: "raised_and_fumbled" as const, comment: "You denied knowledge of the crack." }],
  one_thing_to_practice: "Say what you knew and when, before you are asked twice.",
};

const news = {
  soundbite: "We knew nothing about it",
  soundbite_turn: 1,
  channel: "Riverside Tonight",
  anchor_intro: "Good evening. A local cafe owner faced questions today over a cracked display case at the shop.",
  anchor_outro: "The cafe says the pastries were pulled at once.",
  chyron: "Owner faces questions",
  ticker: ["Cafe case cracked", "Owner answers press", "More at ten"],
};
const debriefWithNews = { ...sampleDebrief, news };

function pcm16(ms: number, value = 1000): Uint8Array {
  const samples = Math.round((ms / 1000) * 16000);
  const out = new Uint8Array(samples * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) v.setInt16(i * 2, value, true);
  return out;
}

function timedBuffer(sessionId: string) {
  ownerAudioRegistry.delete(sessionId);
  const buf = getOrCreateOwnerAudio(sessionId, 350);
  // 100 ms frames interleaved with cumulative partials.
  const frame = pcm16(100, 800);
  const partials = ["We", "We knew", "We knew nothing", "We knew nothing about", "We knew nothing about it"];
  for (let i = 0; i < 20; i++) {
    buf.push(frame, i * 100);
    if (i - 5 >= 0 && i - 5 < partials.length) buf.notePartial(partials[i - 5]!);
  }
  buf.sealTurn("We knew nothing about it", null);
  return buf;
}

describe("news schema (brief 14)", () => {
  it("accepts a valid news item and rejects long soundbites and intros", () => {
    expect(debriefSchema.parse(debriefWithNews).news?.channel).toBe("Riverside Tonight");
    expect(() => debriefSchema.parse({ ...debriefWithNews, news: { ...news, soundbite: "too short" } })).toThrow();
    expect(() =>
      debriefSchema.parse({
        ...debriefWithNews,
        news: { ...news, anchor_intro: Array.from({ length: 36 }, (_, i) => `w${i}`).join(" ") },
      }),
    ).toThrow();
    expect(() =>
      debriefSchema.parse({ ...debriefWithNews, news: { ...news, chyron: "one two three four five six seven eight nine" } }),
    ).toThrow();
  });
  it("old debriefs without news still parse", () => {
    expect(debriefSchema.parse(sampleDebrief).news).toBeUndefined();
  });
});

describe("word-time mapping from partials", () => {
  it("uses first appearance minus the ASR lag", () => {
    const times = buildWordTimes(
      [
        { text: "We", audioOffsetMs: 1000 },
        { text: "We knew", audioOffsetMs: 1400 },
        { text: "We knew nothing", audioOffsetMs: 1800 },
      ],
      350,
    );
    expect(times.map((t) => [t.word, t.startMs])).toEqual([
      ["we", 650],
      ["knew", 1050],
      ["nothing", 1450],
    ]);
  });
  it("live transcript events carry no word timings (fixture), synthetic ones do", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/muse-transcript-event.json", import.meta.url), "utf8"),
    ) as { event: Record<string, unknown>; finalEvent: Record<string, unknown> };
    expect(extractWordTimings(fixture.event)).toBeNull();
    expect(extractWordTimings(fixture.finalEvent)).toBeNull();
    expect(
      extractWordTimings({ type: "transcript", words: [{ word: "hi", startMs: 10, endMs: 90 }] }),
    ).toEqual([{ word: "hi", startMs: 10, endMs: 90 }]);
  });
});

describe("fuzzy quote location and cut", () => {
  it("finds the quote despite a small transcript difference", () => {
    const match = fuzzyFindQuote("Well we knew nothing about it at all", "We knew nothing about it");
    expect(match).toMatchObject({ startWord: 1, endWord: 6 });
    expect(match!.score).toBeGreaterThanOrEqual(0.75);
    expect(fuzzyFindQuote("Completely different words here now", "We knew nothing about it")).toBeNull();
  });
  it("pads the cut and snaps edges to quiet frames", () => {
    const times = buildWordTimes(
      [
        { text: "We knew", audioOffsetMs: 1000 },
        { text: "We knew nothing about it", audioOffsetMs: 2000 },
      ],
      0,
    );
    const cut = computeCut(times, { startWord: 1, endWord: 5, score: 1 }, 3000);
    expect(cut.startMs).toBe(750);
    // Loud audio everywhere except a quiet gap at 700-760 ms.
    const pcm = pcm16(3000, 5000);
    const view = new DataView(pcm.buffer);
    for (let s = Math.round(0.7 * 16000); s < Math.round(0.76 * 16000); s++) view.setInt16(s * 2, 0, true);
    const snapped = snapCut(pcm, 16000, cut);
    expect(snapped.startMs).toBeGreaterThanOrEqual(650);
    expect(snapped.startMs).toBeLessThanOrEqual(800);
    expect(snapped.endMs).toBeGreaterThan(snapped.startMs);
  });
  it("locates the soundbite in the buffer and reports weak matches as unlocated", () => {
    const buf = timedBuffer("locate-1");
    const turns = [{ role: "user" as const, text: "We knew nothing about it", elapsedSeconds: 5, flags: [] }];
    const found = locateSoundbite(buf, turns, news);
    expect(found.located).toBe(true);
    if (found.located) expect(found.segmentPcm16.length).toBeGreaterThan(0);
    const missing = locateSoundbite(buf, turns, { ...news, soundbite: "I never said anything like that" });
    expect(missing.located).toBe(false);
    ownerAudioRegistry.delete("locate-1");
  });
});

describe("clip timeline and WAV", () => {
  it("builds a timeline with 400 ms gaps and a valid WAV header", () => {
    const timeline = buildTimeline([
      { part: "intro", text: "a", durationMs: 1000 },
      { part: "soundbite", text: "b", durationMs: 500 },
      { part: "outro", text: "c", durationMs: 1000 },
    ]);
    expect(timeline.map((p) => [p.part, p.startMs, p.endMs])).toEqual([
      ["intro", 0, 1000],
      ["soundbite", 1400, 1900],
      ["outro", 2300, 3300],
    ]);
    const { wav, timeline: t2 } = assembleClip([
      { part: "intro", text: "a", pcm: pcm16(100).slice() },
      { part: "soundbite", text: "b", pcm: pcm16(100).slice() },
      { part: "outro", text: "c", pcm: pcm16(100).slice() },
    ], 16000);
    expect(t2).toHaveLength(3);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(encodeWav(new Uint8Array(4), 24000).length).toBe(48);
  });
});

function fakeTts(gate?: Promise<void>) {
  const texts: string[] = [];
  const tts: TextToSpeech = {
    async *synthesize(text: string) {
      texts.push(text);
      if (gate) await gate;
      yield pcm16(50, 300);
    },
  };
  return { tts, texts };
}

const fakeImage: ImageGen = {
  generateImage: async () => ({ image: new Uint8Array([1, 2]), mimeType: "image/webp" }),
  editPhoto: async () => ({ image: new Uint8Array([1, 2]), mimeType: "image/webp" }),
};

function makeNewsApp(opts: { tts: TextToSpeech; withNews?: boolean; sessionId?: string }) {
  const store = new ScenarioStore();
  const sessions = new SessionStore();
  const id = opts.sessionId ?? store.add(cafeTestScenario);
  const turns = [{ role: "user" as const, text: "We knew nothing about it", elapsedSeconds: 5, flags: [] as never[] }];
  sessions.put({ id, scenario: cafeTestScenario, startedAtMs: 0, turns });
  const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
    store,
    sessions,
    generateDebrief: async () =>
      debriefSchema.parse(opts.withNews === false ? sampleDebrief : debriefWithNews),
    imageGen: fakeImage,
    tts: opts.tts,
  });
  return { app, id };
}

async function pollClip(app: ReturnType<typeof buildApp>, id: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip` });
    if (res.statusCode !== 202) return res;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("news clip stayed at 202");
}

describe("news-clip endpoint", () => {
  it("states: 404 unknown, 404 without news, 202 while building, 200 ready with fallback quote read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { tts, texts } = fakeTts(gate);
    const { app, id } = makeNewsApp({ tts });
    expect((await app.inject({ method: "GET", url: "/api/sessions/nope/news-clip" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip` })).statusCode).toBe(404);
    const debriefRes = await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    expect(debriefRes.statusCode).toBe(200);
    const building = await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip` });
    expect(building.statusCode).toBe(202);
    release();
    const ready = await pollClip(app, id);
    expect(ready.statusCode).toBe(200);
    const body = ready.json();
    expect(body.channel).toBe("Riverside Tonight");
    expect(body.soundbiteLocated).toBe(false);
    expect(body.timeline.map((p: { part: string }) => p.part)).toEqual(["intro", "soundbite", "outro"]);
    expect(texts.some((t) => t.includes("The owner told us, quote,"))).toBe(true);
    const audio = await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip/audio` });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toContain("audio/wav");
    await app.close();
  });

  it("old debriefs without news show no clip", async () => {
    const { tts } = fakeTts();
    const { app, id } = makeNewsApp({ tts, withNews: false });
    await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/news-clip` })).statusCode).toBe(404);
    await app.close();
  });

  it("uses the owner's own voice when located and keeps only the segment", async () => {
    const sessionId = "news-located-session";
    const buf = timedBuffer(sessionId);
    const before = buf.byteLength;
    const { tts, texts } = fakeTts();
    const { app, id } = makeNewsApp({ tts, sessionId });
    await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    const ready = await pollClip(app, id);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().soundbiteLocated).toBe(true);
    expect(texts.some((t) => t.includes("The owner told us, quote,"))).toBe(false);
    expect(buf.byteLength).toBeLessThan(before);
    expect(buf.retainedSegment).not.toBeNull();
    ownerAudioRegistry.delete(sessionId);
    await app.close();
  });
});
