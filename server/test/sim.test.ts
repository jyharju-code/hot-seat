import { describe, expect, it } from "vitest";
import {
  detectSplit,
  isRepeat,
  mean,
  median,
  normalizeText,
  stripCutOff,
  textSimilarity,
  wordErrorRate,
  worst,
} from "../scripts/sim/metrics.js";
import {
  buildFramePlan,
  pcmDurationMs,
  shouldStopSpeaking,
  silenceBytes,
  takeUntilInterrupt,
} from "../scripts/sim/pacing.js";
import { estimateTtsChars, parseOwnerSegments } from "../scripts/sim/owner.js";
import { estimateTotalChars, parseArgs } from "../scripts/sim/main.js";

describe("sim WER", () => {
  it("is zero for identical text after normalisation", () => {
    expect(wordErrorRate("We closed the café, that morning!", "we closed the cafe that morning")).toBeGreaterThan(0);
    expect(wordErrorRate("We closed it that morning!", "we closed it that morning")).toBe(0);
  });

  it("counts substitutions, insertions and deletions per reference word", () => {
    expect(wordErrorRate("we closed it that morning", "we closed it that evening")).toBeCloseTo(1 / 5);
    expect(wordErrorRate("we closed it", "we closed it today")).toBeCloseTo(1 / 3);
    expect(wordErrorRate("we closed it today", "we closed it")).toBeCloseTo(1 / 4);
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "surprise words")).toBe(1);
    expect(wordErrorRate("spoken words", "")).toBe(1);
  });

  it("normalises case and punctuation away", () => {
    expect(normalizeText("  When, exactly... DID you know?! ")).toBe("when exactly did you know");
  });
});

describe("sim split detection", () => {
  it("flags more than one transcript for one answer", () => {
    expect(detectSplit({ transcriptCount: 2, firstTranscriptAtMs: 5000, speechEndMs: 4000 })).toBe(true);
  });

  it("flags a transcript that closed before the owner finished speaking", () => {
    expect(detectSplit({ transcriptCount: 1, firstTranscriptAtMs: 3000, speechEndMs: 4000 })).toBe(true);
  });

  it("accepts one transcript after speech end, and no transcript", () => {
    expect(detectSplit({ transcriptCount: 1, firstTranscriptAtMs: 4500, speechEndMs: 4000 })).toBe(false);
    expect(detectSplit({ transcriptCount: 0, firstTranscriptAtMs: null, speechEndMs: 4000 })).toBe(false);
  });
});

describe("sim repeat detection", () => {
  it("flags an essentially repeated question above 0.8 similarity", () => {
    const a = "When exactly did you know about the broken case?";
    expect(isRepeat(a, "When exactly did you know about the broken case")).toBe(true);
    expect(textSimilarity(a, a)).toBe(1);
  });

  it("does not flag a different question", () => {
    expect(isRepeat("When did you know?", "Who decided to tape the case instead of replacing it?")).toBe(false);
    expect(isRepeat("", "When did you know?")).toBe(false);
  });
});

describe("sim pacing schedule with pauses", () => {
  it("lays out audio frames then pause silence frames on an absolute clock", () => {
    const plan = buildFramePlan([
      { durationMs: 250, pauseAfterMs: 1000 },
      { durationMs: 100, pauseAfterMs: 0 },
    ]);
    expect(plan.filter((f) => !f.silence)).toHaveLength(4);
    expect(plan.filter((f) => f.silence)).toHaveLength(10);
    expect(plan[0]!.atMs).toBe(0);
    expect(plan[3]).toEqual({ atMs: 300, segmentIndex: 0, silence: true });
    expect(plan[12]!.atMs).toBe(1200);
    expect(plan[13]).toEqual({ atMs: 1300, segmentIndex: 1, silence: false });
  });

  it("converts PCM bytes and pause lengths", () => {
    expect(pcmDurationMs(32000)).toBe(1000);
    expect(silenceBytes(1500)).toBe(48000);
    expect(silenceBytes(0)).toBe(0);
  });

  it("stops on interrupt: frames due at or after the interrupt are dropped", () => {
    const plan = buildFramePlan([{ durationMs: 2000, pauseAfterMs: 500 }]);
    const kept = takeUntilInterrupt(plan, 550);
    expect(kept).toHaveLength(6);
    expect(kept.every((f) => f.atMs < 550)).toBe(true);
    expect(takeUntilInterrupt(plan, null)).toHaveLength(plan.length);
    expect(shouldStopSpeaking(true)).toBe(true);
    expect(shouldStopSpeaking(false)).toBe(false);
  });
});

describe("sim owner segments and CLI", () => {
  it("parses segments and clamps pauses to 0..2500", () => {
    const segments = parseOwnerSegments(
      'noise {"segments":[{"text":" We knew that morning. ","pause_after_ms":9000},{"text":"We closed it.","pause_after_ms":-5},{"text":"  "}]}',
    );
    expect(segments).toEqual([
      { text: "We knew that morning.", pause_after_ms: 2500 },
      { text: "We closed it.", pause_after_ms: 0 },
    ]);
    expect(estimateTtsChars(segments)).toBe("We knew that morning.".length + "We closed it.".length);
    expect(() => parseOwnerSegments("no json")).toThrow();
  });

  it("parses CLI flags and estimates TTS characters for the cost guard", () => {
    const args = parseArgs(["--profiles", "rambler,hesitant", "--turns", "2", "--debrief", "--max-chars", "5000"]);
    expect(args).toMatchObject({ profiles: "rambler,hesitant", turns: 2, debrief: true, maxChars: 5000 });
    expect(estimateTotalChars(6, 4)).toBe(14400);
    expect(estimateTotalChars(6, 10)).toBeGreaterThan(20000);
  });

  it("aggregates median, mean and worst", () => {
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200])).toBe(150);
    expect(median([])).toBeNull();
    expect(mean([1, 2, 3])).toBe(2);
    expect(worst([1, 9, 3])).toBe(9);
    expect(stripCutOff("We take this seriously (cut off)")).toBe("We take this seriously");
  });
});
