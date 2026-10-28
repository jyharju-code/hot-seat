import { describe, expect, it } from "vitest";
import {
  PARTIAL_STABLE_MS,
  TURN_END_HESITANT_MS,
  TURN_END_SILENCE_MS,
  isHesitantAnswer,
  normaliseTranscript,
  transcriptWordCount,
  transcriptsMatchNormalised,
  turnEndSilenceMs,
} from "../src/session/turn-end.js";

describe("adaptive turn-end silence", () => {
  it("defaults: 1000 ms complete, 3200 ms hesitant", () => {
    expect(TURN_END_SILENCE_MS).toBe(1000);
    expect(TURN_END_HESITANT_MS).toBe(3200);
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(isHesitantAnswer(complete)).toBe(false);
    expect(turnEndSilenceMs(complete)).toBe(1000);
    expect(turnEndSilenceMs("well, so the thing is I, let me think.")).toBe(3200);
  });

  it("owner_done true ends at the normal window even for hesitant wording", () => {
    expect(turnEndSilenceMs("well, so the thing is I, let me think.", {}, true)).toBe(1000);
    expect(turnEndSilenceMs("We closed it.", { silenceMs: 100, hesitantMs: 900 }, true)).toBe(100);
  });

  it("owner_done false waits the hesitant window even for a complete sentence", () => {
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(turnEndSilenceMs(complete, {}, false)).toBe(3200);
    expect(turnEndSilenceMs(complete, { silenceMs: 100, hesitantMs: 900 }, false)).toBe(900);
  });

  it("owner_done not arrived falls back to the word heuristic", () => {
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(turnEndSilenceMs(complete, {}, null)).toBe(1000);
    expect(turnEndSilenceMs(complete, {}, undefined)).toBe(1000);
    expect(turnEndSilenceMs("well, so the thing is I, let me think.", {}, null)).toBe(3200);
  });

  it("pending speculative result waits for the LLM up to the hesitant cap, not the heuristic", () => {
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(turnEndSilenceMs(complete, {}, { kind: "pending" })).toBe(3200);
    expect(turnEndSilenceMs("Yeah, yeah,", {}, { kind: "pending" })).toBe(3200);
    expect(turnEndSilenceMs(complete, { silenceMs: 100, hesitantMs: 900 }, { kind: "pending" })).toBe(900);
  });

  it("arrived speculative result decides: true at normal window, false or missing judgement waits or uses heuristic", () => {
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(turnEndSilenceMs("Yeah, yeah,", {}, { kind: "done", ownerDone: true })).toBe(1000);
    expect(turnEndSilenceMs(complete, {}, { kind: "done", ownerDone: false })).toBe(3200);
    expect(turnEndSilenceMs(complete, {}, { kind: "done", ownerDone: null })).toBe(1000);
    expect(turnEndSilenceMs("well, so the thing is I, let me think.", {}, { kind: "done", ownerDone: null })).toBe(3200);
  });

  it("failed speculative call falls back to the word heuristic", () => {
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(turnEndSilenceMs(complete, {}, { kind: "failed" })).toBe(1000);
    expect(turnEndSilenceMs("Yeah, yeah,", {}, { kind: "failed" })).toBe(3200);
    expect(turnEndSilenceMs(complete, {}, "failed")).toBe(1000);
  });

  it("under 8 words is hesitant even with a full stop", () => {
    expect(isHesitantAnswer("We closed it.")).toBe(true);
    expect(isHesitantAnswer("We closed the cafe that morning and told customers.")).toBe(false);
  });

  it.each([
    "We were about to explain the whole thing so",
    "We checked the kitchen records and",
    "It was not my decision but",
    "We stayed open because",
    "Nobody told me, or",
    "We, um",
    "The results came back, uh",
    "It was, er",
    "It felt, like",
    "I mean",
    "That is not the whole story, I mean",
    "The point is, the thing is",
    "Hold on, let me think",
    "We did everything, you know",
    "Well",
    "So, well",
  ])("trailing filler is hesitant: %s", (text) => {
    // Pad short cases past 8 words only where the filler itself is the point:
    // all cases here are either short (hesitant anyway) or end in a filler.
    expect(isHesitantAnswer(text)).toBe(true);
    expect(turnEndSilenceMs(text)).toBe(TURN_END_HESITANT_MS);
  });

  it("long answers ending in a filler are hesitant despite word count", () => {
    expect(isHesitantAnswer("We closed the cafe that morning and then we, well")).toBe(true);
    expect(isHesitantAnswer("We closed the cafe that morning and then I started to, let me think")).toBe(true);
  });

  it("ending with a comma is hesitant", () => {
    expect(isHesitantAnswer("We closed the cafe that morning,")).toBe(true);
    expect(turnEndSilenceMs("We closed the cafe that morning,")).toBe(3200);
  });

  it("honours configured values", () => {
    expect(turnEndSilenceMs("Short.", { silenceMs: 100, hesitantMs: 900 })).toBe(900);
    expect(
      turnEndSilenceMs("We closed the cafe that morning and told every customer directly.", {
        silenceMs: 100,
        hesitantMs: 900,
      }),
    ).toBe(100);
  });

  it("normalisation ignores punctuation and casing, and counts words", () => {
    expect(PARTIAL_STABLE_MS).toBe(450);
    expect(normaliseTranscript("  We Closed, the CAFE!  Today. ")).toBe("we closed the cafe today");
    expect(transcriptsMatchNormalised("We closed the cafe today.", "we closed the cafe today")).toBe(true);
    expect(transcriptsMatchNormalised("We closed the cafe today.", "We refunded everyone.")).toBe(false);
    expect(transcriptWordCount("one two three")).toBe(3);
    expect(transcriptWordCount("  ")).toBe(0);
  });

  it("empty text is not hesitant", () => {
    expect(isHesitantAnswer("")).toBe(false);
    expect(isHesitantAnswer("   ")).toBe(false);
  });
});
