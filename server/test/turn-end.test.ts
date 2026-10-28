import { describe, expect, it } from "vitest";
import {
  TURN_END_HESITANT_MS,
  TURN_END_SILENCE_MS,
  isHesitantAnswer,
  turnEndSilenceMs,
} from "../src/session/turn-end.js";

describe("adaptive turn-end silence", () => {
  it("defaults: 1500 ms complete, 3200 ms hesitant", () => {
    expect(TURN_END_SILENCE_MS).toBe(1500);
    expect(TURN_END_HESITANT_MS).toBe(3200);
    const complete = "We closed the cafe that morning and told every customer directly.";
    expect(isHesitantAnswer(complete)).toBe(false);
    expect(turnEndSilenceMs(complete)).toBe(1500);
    expect(turnEndSilenceMs("well, so the thing is I, let me think.")).toBe(3200);
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

  it("empty text is not hesitant", () => {
    expect(isHesitantAnswer("")).toBe(false);
    expect(isHesitantAnswer("   ")).toBe(false);
  });
});
