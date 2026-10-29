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
import { ReporterLineQueue, linePlaybackMs } from "../scripts/sim/reporter-queue.js";
import { estimateTotalChars, parseArgs } from "../scripts/sim/main.js";
import { pollFrontPage, pollNewsClip, browserFirstAudioAt, listeningWaitSatisfied } from "../scripts/sim/client.js";
import { buildReport } from "../scripts/sim/report.js";
import { PROFILE_WRAP_UP_LINE, isWrapUpLine } from "@hot-seat/shared";

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

describe("sim reporter line queue", () => {
  it("consumes exactly one ended line per turn, in order", () => {
    const q = new ReporterLineQueue();
    q.noteText("Opening question?");
    q.noteAudio(4800);
    expect(q.consume()).toBeUndefined();
    q.noteAudioEnd();
    q.noteText("Follow-up?");
    q.noteAudio(9600);
    q.noteAudioEnd();
    expect(q.pendingCount).toBe(2);
    expect(q.consume()).toEqual({ text: "Opening question?", audioBytes: 4800, ended: true });
    expect(q.consume()).toEqual({ text: "Follow-up?", audioBytes: 9600, ended: true });
    expect(q.consume()).toBeUndefined();
  });

  it("a reply that ended before the turn looked for it is not missed", () => {
    const q = new ReporterLineQueue();
    q.noteText("Fast reply.");
    q.noteAudio(48000);
    q.noteAudioEnd();
    // No baseline was taken before the reply finished; it is still there.
    expect(q.hasEndedLine()).toBe(true);
    expect(linePlaybackMs(q.peekEnded()!)).toBe(1000);
    expect(q.consume()?.text).toBe("Fast reply.");
    expect(q.hasEndedLine()).toBe(false);
  });

  it("audio arriving before its transcript still lands on the same line", () => {
    const q = new ReporterLineQueue();
    q.noteAudio(2400);
    q.noteText("Cut in!");
    q.noteAudio(2400);
    q.noteAudioEnd();
    expect(q.consume()).toEqual({ text: "Cut in!", audioBytes: 4800, ended: true });
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

  it("polls the front-page endpoint through 202s until it is ready", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetchFn = (async (url: string) => {
      urls.push(url);
      calls += 1;
      if (calls < 3) return { status: 202, ok: false, json: async () => ({ status: "printing", frontPage: null }) };
      return { status: 200, ok: true, json: async () => ({ frontPage: { imageBase64: "x", mime: "image/png" } }) };
    }) as unknown as typeof fetch;
    const result = await pollFrontPage("http://127.0.0.1:3001", "sess-1", {
      fetchFn,
      intervalMs: 1,
      sleepFn: async () => undefined,
    });
    expect(result.front_page).toBe(true);
    expect(calls).toBe(3);
    expect(urls.every((u) => u === "http://127.0.0.1:3001/api/sessions/sess-1/front-page")).toBe(true);
  });

  it("polls the news-clip endpoint through 202s and reports soundbite location", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 2) return { status: 202, ok: false, json: async () => ({ status: "building" }) };
      return { status: 200, ok: true, json: async () => ({ soundbiteLocated: true }) };
    }) as unknown as typeof fetch;
    const result = await pollNewsClip("http://127.0.0.1:3001", "sess-1", {
      fetchFn,
      intervalMs: 1,
      sleepFn: async () => undefined,
    });
    expect(result.news_clip).toBe(true);
    expect(result.soundbite_located).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("front-page polling gives up at the cap and reports a failed page", async () => {
    const printing = (async () => ({ status: 202, ok: false, json: async () => ({ frontPage: null }) })) as unknown as typeof fetch;
    const timedOut = await pollFrontPage("http://x", "s", { fetchFn: printing, intervalMs: 1, maxWaitMs: 5, sleepFn: async () => undefined });
    expect(timedOut.front_page).toBe(false);
    const failed = (async () => ({ status: 200, ok: true, json: async () => ({ frontPage: null }) })) as unknown as typeof fetch;
    const failedResult = await pollFrontPage("http://x", "s", { fetchFn: failed, sleepFn: async () => undefined });
    expect(failedResult.front_page).toBe(false);
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

describe("sim browser latency and profile ending (brief 16b)", () => {
  it("browser first audio is reporter_line arrival plus speechStartMs", () => {
    expect(browserFirstAudioAt(1000, null)).toBe(1000);
    expect(browserFirstAudioAt(1000, 120)).toBe(1120);
    expect(browserFirstAudioAt(1000, -5)).toBe(1000);
  });
  it("session_complete satisfies the listening wait, so the sim ends normally and debriefs instead of timing out", () => {
    expect(listeningWaitSatisfied("speaking", true)).toBe(true);
    expect(listeningWaitSatisfied("listening", false)).toBe(true);
    expect(listeningWaitSatisfied("speaking", false)).toBe(false);
    expect(listeningWaitSatisfied(null, true)).toBe(true);
  });
  it("report prints session_complete and wrap-up for profile runs only", () => {
    expect(isWrapUpLine(PROFILE_WRAP_UP_LINE)).toBe(true);
    expect(isWrapUpLine("Tell me more about the early days.")).toBe(false);
    const base = { profile: "p", preset: "x", session_id: "s1", turns: [], transcript: [], errors: 0, failure: null, debrief: null };
    const profileReport = buildReport([{ ...base, mode: "profile" as const, session_complete: true, wrap_up_spoken: false }], { preset: "x", turns: 4, at: "t" });
    expect(profileReport).toContain("Profile ending: session_complete yes, wrap-up spoken no");
    const hotReport = buildReport([{ ...base, mode: "hot_seat" as const, session_complete: true, wrap_up_spoken: true }], { preset: "x", turns: 4, at: "t" });
    expect(hotReport).not.toContain("Profile ending:");
  });
});
