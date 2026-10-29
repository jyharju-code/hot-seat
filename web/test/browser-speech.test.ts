import { describe, expect, it, vi } from "vitest";
import { BrowserSpeech, localEnglishVoices, pickVoice, sentenceTimeoutMs, splitSentences } from "../src/audio/browser-speech.js";

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
    expect(pickVoice(voices, { role: "reporter", temperament: "human", gender: "female" }).voice?.name).toBe("Samantha");
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
