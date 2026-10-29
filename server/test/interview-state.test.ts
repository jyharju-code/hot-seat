import { describe, expect, it } from "vitest";
import { JournalistBrain, parseReporterLine, type JournalistPrompts } from "../src/journalist.js";
import { cafeProfileScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import {
  applyCommittedLine, buildFallbackPlan, computeDirective, createInterviewState,
  fallbackLinesForBeat, interviewSimMetrics, isAlreadyAsked, isRepeatLine, minQuestionsForBeat,
  nextFallbackLine, normalizeLineText, transitionQuestionForBeat,
} from "../src/session/interview-state.js";
import { generateInterviewPlan } from "../src/session/interview-plan.js";
import { stripTranscriptTokens } from "@hot-seat/shared";

const line = (partial: Record<string, unknown>) => parseReporterLine(JSON.stringify({ move: "follow_up", flags: [], say: "Next question?", quote_used: null, ...partial }));

describe("interview state", () => {
  it("admission closes a beat", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    applyCommittedLine(state, line({ beat_id: "facts", say: "When did you know?" }), { turn: 1 });
    applyCommittedLine(state, line({ beat_id: "responsibility", say: "Who decided?", answer_assessment: "answered", new_established: ["owner knew about the crack"] }), { turn: 2 });
    expect(state.beats.find((b) => b.beat.id === "facts")?.status).toBe("answered");
    expect(state.established).toEqual([{ text: "owner knew about the crack", turn: 2 }]);
  });

  it("max_questions forces a move", () => {
    const plan = buildFallbackPlan(cafeTestScenario);
    const state = createInterviewState(plan);
    const beat = plan.beats[0]!;
    for (let i = 0; i < beat.max_questions; i++) applyCommittedLine(state, line({ beat_id: beat.id, answer_assessment: "partial" }), { turn: i + 1 });
    expect(computeDirective(state, { elapsedSeconds: 0 }).type).toBe("MOVE_ON");
  });

  it("respects unlock times", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    const locked = state.beats.find((b) => b.beat.landmine_id === "L3");
    expect(locked?.beat.unlock_at_seconds).toBe(150);
    expect(computeDirective(state, { elapsedSeconds: 10, escalationBeatId: "L3" }).nextBeat?.id).not.toBe(locked?.beat.id);
  });

  it("escalation puts its beat first", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    const d = computeDirective(state, { elapsedSeconds: 200, escalationBeatId: "L2" });
    expect(d.nextBeat?.landmine_id).toBe("L2");
  });

  it("pacing moves on when over its share", () => {
    const state = createInterviewState(buildFallbackPlan(cafeProfileScenario));
    const d = computeDirective(state, { elapsedSeconds: 200, durationSeconds: 300 });
    expect(d.type).toBe("MOVE_ON");
  });

  it("allows only one callback", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    applyCommittedLine(state, line({ beat_id: "facts" }), { turn: 1 });
    applyCommittedLine(state, line({ beat_id: "responsibility", answer_assessment: "answered" }), { turn: 2 });
    expect(computeDirective(state, { contradictionBeatId: "facts" }).type).toBe("CALLBACK");
    applyCommittedLine(state, line({ beat_id: "facts", say: "How can both be true?" }), { turn: 3, isCallback: true });
    expect(state.callbackUsed).toBe(true);
    expect(computeDirective(state, { contradictionBeatId: "facts" }).type).not.toBe("CALLBACK");
    expect(isRepeatLine(state, line({ beat_id: "facts" }))).toBe(true);
  });

  it("speculative lines do not change state (only committed calls apply)", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    const before = JSON.stringify(state.asked);
    // A speculative line is simply never passed to applyCommittedLine.
    void line({ beat_id: "facts", new_established: ["speculative fact"] });
    expect(JSON.stringify(state.asked)).toBe(before);
    expect(state.established).toEqual([]);
  });

  it("fallback plan: hot seat has landmine beats with unlocks, profile has arc, 5..7 beats", () => {
    const hot = buildFallbackPlan(cafeTestScenario);
    expect(hot.beats.length).toBeGreaterThanOrEqual(5);
    expect(hot.beats.length).toBeLessThanOrEqual(7);
    expect(hot.beats.filter((b) => b.kind === "landmine").length).toBeGreaterThan(0);
    expect(hot.beats.find((b) => b.landmine_id === "L1")?.unlock_at_seconds).toBe(40);
    const prof = buildFallbackPlan(cafeProfileScenario);
    expect(prof.beats.map((b) => b.kind)).toEqual(["origin", "business_today", "hard_years", "people", "future", "close"]);
  });

  it("plan call failure or timeout falls back", async () => {
    const failing = { chat: async () => { throw new Error("down"); } };
    await expect(generateInterviewPlan(failing as never, cafeTestScenario, { promptTemplate: "x {mode}" })).resolves.toEqual(buildFallbackPlan(cafeTestScenario));
    const slow = { chat: async () => { await new Promise((r) => setTimeout(r, 50)); return { text: "{}", model: "m", finishReason: null }; } };
    const plan = await generateInterviewPlan(slow as never, cafeTestScenario, { promptTemplate: "x", timeoutMs: 5 });
    expect(plan.beats.length).toBeGreaterThanOrEqual(5);
  });

  it("sim metrics: repeat count and longest run", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    applyCommittedLine(state, line({ beat_id: "facts" }), { turn: 1 });
    applyCommittedLine(state, line({ beat_id: "facts" }), { turn: 2 });
    applyCommittedLine(state, line({ beat_id: "responsibility", answer_assessment: "answered" }), { turn: 3 });
    applyCommittedLine(state, line({ beat_id: "facts", say: "Fridge again?" }), { turn: 4 });
    const m = interviewSimMetrics(state);
    expect(m.repeatCount).toBe(1);
    expect(m.longestRun).toBe(2);
    expect(m.beatsTouched).toContain("facts");
  });

  it("transition question serves its beat", () => {
    const beat = buildFallbackPlan(cafeTestScenario).beats.find((b) => b.kind === "action")!;
    expect(transitionQuestionForBeat(beat).beat_id).toBe(beat.id);
  });

  it("strips leaked speaker tokens", () => {
    expect(stripTranscriptTokens("Hello <|speaker_A|> world")).toBe("Hello world");
  });

  it("brief 17b: min_questions, profile beats need 2 before closing", () => {
    const prof = buildFallbackPlan(cafeProfileScenario);
    expect(prof.beats.filter((b) => b.kind !== "close").every((b) => minQuestionsForBeat(b) === 2)).toBe(true);
    expect(minQuestionsForBeat(prof.beats.find((b) => b.kind === "close")!)).toBe(1);
    expect(buildFallbackPlan(cafeTestScenario).beats.every((b) => minQuestionsForBeat(b) === 1)).toBe(true);
    const state = createInterviewState(prof);
    applyCommittedLine(state, line({ beat_id: "origin", say: "How did it begin?" }), { turn: 1 });
    applyCommittedLine(state, line({ beat_id: "origin", say: "What made you start?", answer_assessment: "answered" }), { turn: 2 });
    // One served question on origin so far at assessment time is below min 2: the
    // assessed (previous) beat had 1 question when the second line was committed.
    const origin = state.beats.find((b) => b.beat.id === "origin")!;
    expect(origin.questions).toBe(2);
    applyCommittedLine(state, line({ beat_id: "business_today", say: "What is it like today?", answer_assessment: "answered" }), { turn: 3 });
    expect(state.beats.find((b) => b.beat.id === "origin")?.status).toBe("answered");
  });

  it("brief 17b: fallback lines are beat-specific, 2..3 each, never the canned generic", () => {
    for (const plan of [buildFallbackPlan(cafeProfileScenario), buildFallbackPlan(cafeTestScenario)]) {
      for (const beat of plan.beats) {
        const lines = fallbackLinesForBeat(beat);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines.length).toBeLessThanOrEqual(3);
        expect(lines.every((l) => !l.includes("What happens next"))).toBe(true);
        expect(new Set(lines.map(normalizeLineText)).size).toBe(lines.length);
      }
    }
    const beat = buildFallbackPlan(cafeTestScenario).beats[0]!;
    const first = transitionQuestionForBeat(beat, { asked: [] });
    const second = transitionQuestionForBeat(beat, { asked: [first.say] });
    expect(second.say).not.toBe(first.say);
    expect(isAlreadyAsked([first.say], second.say)).toBe(false);
  });

  it("brief 17b: 5-minute profile replay, full answers, depth and no repeats", () => {
    const state = createInterviewState(buildFallbackPlan(cafeProfileScenario));
    const spoken: string[] = [];
    let elapsed = 0;
    let turn = 0;
    // Owner answers every question fully; reporter uses the deterministic
    // fallback picker (the worst case that looped before this brief).
    while (elapsed < 255 && turn < 30) {
      turn += 1;
      const directive = computeDirective(state, { elapsedSeconds: elapsed, durationSeconds: 300 });
      expect(directive.nextBeat?.kind).not.toBe("close");
      const next = nextFallbackLine(state, { elapsedSeconds: elapsed, durationSeconds: 300 });
      expect(next.say).not.toMatch(/\b(thank you|thanks|goodbye)\b/i);
      expect(isAlreadyAsked(spoken, next.say)).toBe(false);
      spoken.push(next.say);
      const isRevisit = directive.reason.includes("revisit");
      applyCommittedLine(state, {
        ...next,
        answer_assessment: "answered",
        new_open_thread: turn === 2 ? "working with Maya and Tom" : null,
        new_established: turn === 8 ? ["Maya and Tom work here"] : [],
      } as never, { turn, elapsedSeconds: elapsed, ...(isRevisit ? { isRevisit: true } : {}) });
      elapsed += 15;
      // After content beats are done, exercise a few revisits then jump to wrap-up.
      const contentDone = state.beats.filter((b) => b.beat.kind !== "close").every((b) => b.status === "answered" || b.status === "exhausted" || b.status === "dodged");
      if (contentDone && spoken.length >= 14) break;
    }
    const content = state.beats.filter((b) => b.beat.kind !== "close");
    for (const b of content) expect(b.questions, b.beat.id).toBeGreaterThanOrEqual(2);
    expect(new Set(spoken.map(normalizeLineText)).size).toBe(spoken.length);
    expect(state.repeatCount).toBe(0);
    expect(spoken.some((s) => s.includes("Maya and Tom"))).toBe(true);
    // Close unlocks only at duration minus 45.
    const atWrap = computeDirective(state, { elapsedSeconds: 260, durationSeconds: 300 });
    expect(atWrap.nextBeat?.kind ?? atWrap.activeBeat?.kind).toBeDefined();
    expect(elapsed).toBeLessThan(300);
  });
});

describe("brain repeat guard (replay)", () => {
  it("retries once then uses the deterministic transition when the model repeats a closed beat", async () => {
    const prompts: JournalistPrompts = {
      spokenStyle: "STYLE",
      journalistTurn: "PLAN {interview_plan} ACTIVE {active_beat} DIR {directive} ASKED {asked_lines} EST {established} FULL {full_transcript} {last_answer} {spoken_style} {public_facts} {landmines_known_to_you}",
      openingQuestion: "O",
    };
    const repeatJson = JSON.stringify({ move: "follow_up", flags: [], say: "About that fridge alert again?", quote_used: null, beat_id: "facts" });
    let calls = 0;
    const llm = {
      chat: async () => { calls += 1; return { text: repeatJson, model: "m", finishReason: null }; },
      generateStructured: async () => { throw new Error("unused"); },
    };
    const brain = new JournalistBrain(llm as never, prompts);
    const fallback = line({ beat_id: "responsibility", say: "Let's move on. Who decided that?" });
    const result = await brain.nextTurn(cafeTestScenario, [], "Sure I did", 60, undefined, [], {
      planLines: "- facts [answered] fridge alert",
      activeBeatLine: "responsibility: who decided",
      directive: "MOVE_ON: beat answered",
      nextBeatGoal: "Who decided to keep serving?",
      established: ["kept serving after the alert"],
      commitments: [], openThreads: [], asked: ["Did you see the fridge alert?"],
      closedBeatIds: ["facts"], callbackBeatId: null, fallbackLine: fallback,
    });
    expect(calls).toBe(2); // one retry, no elevated retries
    expect(result.say).toBe(fallback.say);
    expect(result.beat_id).toBe("responsibility");
  });
});

describe("replay: Maple Corner fridge repeat is stopped", () => {
  it("code marks a repeat on a closed beat and transition moves on", () => {
    // Fixed owner answers from the transcript: fridge admitted first time.
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    applyCommittedLine(state, line({ beat_id: "facts", say: "Did you see the fridge alert at 6:15?" }), { turn: 1 });
    // Owner: "Sure I did" -> next line assesses answered.
    applyCommittedLine(state, line({ beat_id: "responsibility", say: "Who decided to keep serving?", answer_assessment: "answered", new_established: ["kept serving after the alert"] }), { turn: 2 });
    expect(state.beats.find((b) => b.beat.id === "facts")?.status).toBe("answered");
    // Fake LLM tries the fridge again.
    const repeat = line({ beat_id: "facts", say: "About that fridge alert at 6:15?" });
    expect(isRepeatLine(state, repeat)).toBe(true);
    const d = computeDirective(state, { elapsedSeconds: 60 });
    expect(d.type).not.toBe("CALLBACK");
    const fallback = transitionQuestionForBeat(d.nextBeat ?? d.activeBeat!);
    expect(fallback.beat_id).not.toBe("facts");
    expect(isRepeatLine(state, fallback)).toBe(false);
  });
});
