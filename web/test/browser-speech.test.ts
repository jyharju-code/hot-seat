import { describe, expect, it, vi } from "vitest";
import { BrowserSpeech, castVoices, isDeniedVoice, localEnglishVoices, pickVoice, sentenceTimeoutMs, splitSentences, voiceBaseName, voiceQualityRank } from "../src/audio/browser-speech.js";

const voices = [
  { name: "Google US English", lang: "en-US", localService: false },
  { name: "Samantha", lang: "en-US", localService: true },
  { name: "Daniel (Enhanced)", lang: "en-GB", localService: true },
  { name: "Suomi", lang: "fi-FI", localService: true },
];

describe("browser speech voices", () => {
  it("only on-device English voices are eligible, never Google network voices", () => {
    expect(localEnglishVoices(voices).map((v) => v.name)).toEqual(["Samantha", "Daniel (Enhanced)"]);
    expect(pickVoice(voices, { role: "anchor" }).voice?.name).toBe("Daniel (Enhanced)");
    // No Martha, Stephanie or Moira here and no flagged default: browser default speaks.
    expect(pickVoice(voices, { role: "reporter", temperament: "human", gender: "female" }).voice).toBeNull();
  });
  it("matches on base name and ranks Premium over Enhanced over plain", () => {
    expect(voiceBaseName("Ava (Premium)")).toBe("Ava");
    expect(voiceBaseName("Ava [en_US]")).toBe("Ava");
    expect(voiceBaseName("Jamie (Premium) [en_GB]")).toBe("Jamie");
    expect(voiceQualityRank("Ava (Premium)")).toBeGreaterThan(voiceQualityRank("Ava (Enhanced)"));
    expect(voiceQualityRank("Ava (Enhanced)")).toBeGreaterThan(voiceQualityRank("Ava"));
    const vs = [
      { name: "Ava", lang: "en-US", localService: true },
      { name: "Ava (Enhanced)", lang: "en-US", localService: true },
      { name: "Ava (Premium)", lang: "en-US", localService: true },
      { name: "Samantha", lang: "en-US", localService: true },
    ];
    expect(pickVoice(vs, { role: "reporter", temperament: "relentless", gender: "female" }).voice?.name).toBe("Ava (Premium)");
    expect(pickVoice(vs.slice(0, 2), { role: "reporter", temperament: "relentless", gender: "female" }).voice?.name).toBe("Ava (Enhanced)");
    // Browser-style plain name still matches the Ava casting slot.
    expect(pickVoice([vs[0]!], { role: "reporter", temperament: "relentless", gender: "female" }).voice?.name).toBe("Ava");
  });
  it("casts each temperament and gender to its first available choice", () => {
    const vs = ["Evan (Enhanced)", "Arthur (Enhanced)", "Daniel (Enhanced)", "Ava (Premium)", "Allison (Enhanced)", "Samantha", "Oliver (Enhanced)", "Serena (Premium)", "Kate (Enhanced)", "Karen", "Aaron (Enhanced)", "Jamie (Premium)", "Martha (Enhanced)", "Stephanie (Enhanced)", "Moira"].map((name) => ({ name, lang: name.includes("Daniel") || name.includes("Arthur") || name.includes("Oliver") || name.includes("Serena") || name.includes("Kate") || name.includes("Jamie") || name.includes("Martha") || name.includes("Stephanie") ? "en-GB" : "en-US", localService: true }));
    expect(pickVoice(vs, { role: "reporter", temperament: "relentless", gender: "male" }).voice?.name).toBe("Evan (Enhanced)");
    expect(pickVoice(vs, { role: "reporter", temperament: "relentless", gender: "female" }).voice?.name).toBe("Ava (Premium)");
    expect(pickVoice(vs, { role: "reporter", temperament: "precise", gender: "male" }).voice?.name).toBe("Oliver (Enhanced)");
    expect(pickVoice(vs, { role: "reporter", temperament: "precise", gender: "female" }).voice?.name).toBe("Serena (Premium)");
    expect(pickVoice(vs, { role: "reporter", temperament: "human", gender: "male" }).voice?.name).toBe("Aaron (Enhanced)");
    expect(pickVoice(vs, { role: "reporter", temperament: "human", gender: "female" }).voice?.name).toBe("Martha (Enhanced)");
    expect(pickVoice(vs, { role: "radio" }).voice?.name).toBe("Jamie (Premium)");
    expect(pickVoice(vs, { role: "anchor" }).voice?.name).toBe("Daniel (Enhanced)");
  });
  it("never picks a novelty or Eloquence voice, even as a fallback", () => {
    const denied = ["Eddy", "Flo", "Grandma", "Albert", "Bad News", "Bubbles", "Whisper", "Zarvox", "Kathy"].map((name) => ({ name, lang: "en-US", localService: true }));
    expect(denied.every((v) => isDeniedVoice(v))).toBe(true);
    expect(pickVoice(denied, { role: "reporter", temperament: "relentless", gender: "male" }).voice).toBeNull();
    const withDefault = [...denied, { name: "Samantha", lang: "en-US", localService: true, default: true }];
    expect(pickVoice(withDefault, { role: "reporter", temperament: "precise", gender: "female" }).voice?.name).toBe("Samantha");
    // A denied voice that is the browser default is still never picked.
    const deniedDefault = [{ name: "Zarvox", lang: "en-US", localService: true, default: true }];
    expect(pickVoice(deniedDefault, { role: "anchor" }).voice).toBeNull();
  });
  it("keeps reporter, radio and anchor voices distinct within a session when an alternative exists", () => {
    const vs = [
      { name: "Jamie (Premium)", lang: "en-GB", localService: true },
      { name: "Daniel (Enhanced)", lang: "en-GB", localService: true },
      { name: "Oliver (Enhanced)", lang: "en-GB", localService: true },
    ];
    const cast = castVoices(vs, { role: "reporter", temperament: "human", gender: "male" });
    expect(cast.reporter.voice?.name).toBe("Jamie (Premium)");
    expect(cast.radio.voice?.name).not.toBe(cast.reporter.voice?.name);
    expect(cast.anchor.voice?.name).not.toBe(cast.reporter.voice?.name);
    expect(new Set([cast.reporter.voice?.name, cast.radio.voice?.name, cast.anchor.voice?.name]).size).toBe(3);
    // Only one usable voice exists: reuse is allowed rather than silence.
    const solo = castVoices([vs[1]!], { role: "reporter", temperament: "human", gender: "male" });
    expect(solo.reporter.voice?.name).toBe("Daniel (Enhanced)");
    expect(solo.radio.voice?.name).toBe("Daniel (Enhanced)");
  });
  it("splits sentences and times out stuck speech by length", () => {
    expect(splitSentences("[sharply] One here. Two there? Three")).toEqual(["One here.", "Two there?", "Three"]);
    expect(sentenceTimeoutMs("one two three")).toBeGreaterThan(3000);
  });
  it("speaks, fires onStart/onDone and strips tags", async () => {
    const spoken: string[] = [];
    const fakeSynth = {
      getVoices: () => voices,
      speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text); u.onstart?.(new Event("start") as SpeechSynthesisEvent); u.onend?.(new Event("end") as SpeechSynthesisEvent); },
      cancel: () => undefined,
      addEventListener: () => undefined,
    };
    let started = false; let done = false;
    const speech = new BrowserSpeech({ synth: fakeSynth as never, createUtterance: (t) => ({ text: t }) as SpeechSynthesisUtterance, onStart: () => { started = true; }, onDone: () => { done = true; } });
    speech.speak("[sharply] Hello world.", { role: "reporter", temperament: "relentless", gender: "male" });
    await vi.waitFor(() => expect(done).toBe(true));
    expect(started).toBe(true); expect(spoken).toEqual(["Hello world."]);
  });
});
