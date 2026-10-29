import { describe, expect, it } from "vitest";
import { parseReporterLine, JournalistBrain, type JournalistPrompts } from "../src/journalist.js";
import {
  activeBeat, applyCommittedLine, applyInterruptLine, beatState, buildFallbackPlan,
  canInterruptBeat, computeDirective, createInterviewState, isRepeatLine,
  landmineFacts, nextFallbackLine, resolveLineBeat,
} from "../src/session/interview-state.js";
import { contentWords, linesMatchText, overlapScore, resolveEffectiveBeatId } from "../src/session/line-match.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import type { InterviewPlan } from "@hot-seat/shared";

const line = (partial: Record<string, unknown>) => parseReporterLine(JSON.stringify({ move: "follow_up", flags: [], say: "Next question?", quote_used: null, ...partial }));

/** The five screening-form lines from hot seat test 1242901 (session b73e3d86). */
const L339 = "Your own screening form, blank in Danny's file three seasons on. Why did YOU skip it?";
const L417 = "Why was the form blank, though?";
const L433 = "Process? Every other coach's form is filled in. Why is Danny's the ONLY one blank?";
const L452 = "But why is Danny's form blank?";
const L514 = "Three seasons ago, rushed, two weeks before kick-off. His screening form still blank. Why did YOU sign that off?";

const SCREENING_FACT = "Danny's screening form was blank for three seasons";

function screeningPlan(): InterviewPlan {
  return {
    beats: [
      { id: "facts", goal: "What happened at the club", done_when: "Owner gives their account", max_questions: 3, kind: "facts" },
      { id: "responsibility", goal: "Who is responsible and what the owner knew", done_when: "Owner states their own role", max_questions: 3, kind: "responsibility" },
      { id: "landmine-L2", goal: `Confront: ${SCREENING_FACT}`, done_when: `Owner answers about: ${SCREENING_FACT}`, max_questions: 2, kind: "landmine", landmine_id: "L2" },
      { id: "action", goal: "Concrete action with a deadline", done_when: "Owner commits to an action", max_questions: 3, kind: "action" },
      { id: "close", goal: "Close the interview", done_when: "Reporter closes", max_questions: 2, kind: "close" },
    ],
  };
}

describe("brief 18b: content-word overlap", () => {
  it("the two interrupt lines match the 3:39 screening-form line", () => {
    expect(linesMatchText(L417, L339)).toBe(true);
    expect(linesMatchText(L452, L339)).toBe(true);
    expect(overlapScore(L452, L339)).toBeGreaterThan(0);
    expect(contentWords(L417)).toEqual(expect.arrayContaining(["form", "blank"]));
  });

  it("unrelated lines do not match", () => {
    expect(linesMatchText(L339, "What will you send parents in writing by eight tonight?")).toBe(false);
    expect(overlapScore(L339, "What will you send parents in writing by eight tonight?")).toBeLessThan(0.5);
  });

  it("the parents lines stay on their open action beat, never a different beat", () => {
    const state = createInterviewState(screeningPlan());
    const first = "What will you send parents in writing by eight tonight?";
    const second = "Will every parent have that in writing by eight tonight?";
    applyCommittedLine(state, line({ beat_id: "action", say: first }), { turn: 1 });
    const resolved = resolveLineBeat(state, { beat_id: "action", say: second });
    expect(resolved).toBe("action");
    expect(isRepeatLine(state, { beat_id: "action", say: second })).toBe(false);
  });

  it("a screening-form line labelled responsibility resolves to landmine-L2", () => {
    const state = createInterviewState(screeningPlan());
    expect(landmineFacts(state)).toContainEqual({ beatId: "landmine-L2", fact: expect.stringContaining("screening form") });
    expect(resolveLineBeat(state, { beat_id: "responsibility", say: L339 })).toBe("landmine-L2");
    expect(resolveLineBeat(state, { beat_id: "responsibility", say: L514 })).toBe("landmine-L2");
    // A line with no landmine words keeps the model's label.
    expect(resolveLineBeat(state, { beat_id: "responsibility", say: "Who made that call, and when?" })).toBe("responsibility");
  });

  it("resolveEffectiveBeatId prefers the declared landmine beat for its own fact", () => {
    const ctx = {
      asked: [L339],
      askedBeats: ["landmine-L2" as string | undefined],
      landmineFacts: [{ beatId: "landmine-L2", fact: SCREENING_FACT }],
    };
    expect(resolveEffectiveBeatId(L433, "landmine-L2", ctx)).toBe("landmine-L2");
    expect(resolveEffectiveBeatId("Who made that call?", "responsibility", ctx)).toBe("responsibility");
    expect(resolveEffectiveBeatId(L452, undefined, ctx)).toBe("landmine-L2");
  });
});

describe("brief 18b: replay of the five screening-form lines", () => {
  it("at most two normal questions plus one interrupt on the form, then moves on", () => {
    const state = createInterviewState(screeningPlan());
    // 3:39, labelled responsibility by the model, but it is the L2 landmine.
    applyCommittedLine(state, line({ beat_id: "responsibility", say: L339, answer_assessment: "partial" }), { turn: 1 });
    expect(resolveLineBeat(state, { beat_id: "responsibility", say: L339 })).toBe("landmine-L2");
    expect(beatState(state, "landmine-L2")?.questions).toBe(1);
    expect(activeBeat(state)?.id).toBe("landmine-L2");

    // 4:17 interrupt: counts as the second question on L2, exhausting it.
    const interruptBeat = applyInterruptLine(state, L417, { turn: 2 });
    expect(interruptBeat).toBe("landmine-L2");
    expect(beatState(state, "landmine-L2")?.questions).toBe(2);
    expect(beatState(state, "landmine-L2")?.status).toBe("exhausted");
    expect(canInterruptBeat(state, "landmine-L2")).toBe(false);

    // 4:33 serves the spent L2 beat: a repeat, so the deterministic
    // fallback moves the interview on instead.
    expect(isRepeatLine(state, { beat_id: "landmine-L2", say: L433 })).toBe(true);
    const moved = nextFallbackLine(state, { elapsedSeconds: 60 });
    expect(moved.beat_id).not.toBe("landmine-L2");
    applyCommittedLine(state, { ...moved, answer_assessment: "partial" } as never, { turn: 3 });

    // 4:52: no second interrupt is offered on L2, and the text still serves it.
    expect(canInterruptBeat(state, "landmine-L2")).toBe(false);
    expect(resolveLineBeat(state, { beat_id: undefined, say: L452 })).toBe("landmine-L2");
    expect(isRepeatLine(state, { beat_id: undefined, say: L452 })).toBe(true);

    // 5:14, labelled responsibility again: still the L2 landmine, still spent.
    expect(resolveLineBeat(state, { beat_id: "responsibility", say: L514 })).toBe("landmine-L2");
    expect(isRepeatLine(state, { beat_id: "responsibility", say: L514 })).toBe(true);
    const moved2 = nextFallbackLine(state, { elapsedSeconds: 120 });
    expect(moved2.beat_id).not.toBe("landmine-L2");

    // Tally: one normal question plus one interrupt served L2, then it moved on.
    expect(state.servedBeats.filter((b) => b === "landmine-L2")).toHaveLength(2);
    expect(beatState(state, "landmine-L2")?.questions).toBe(2);
    const directive = computeDirective(state, { elapsedSeconds: 120 });
    expect(directive.activeBeat?.id).not.toBe("landmine-L2");
    expect(directive.nextBeat?.id).not.toBe("landmine-L2");
  });

  it("two normal landmine questions on their own also close the beat", () => {
    const state = createInterviewState(screeningPlan());
    applyCommittedLine(state, line({ beat_id: "responsibility", say: L339, answer_assessment: "partial" }), { turn: 1 });
    applyCommittedLine(state, line({ beat_id: "landmine-L2", say: L433, answer_assessment: "dodged" }), { turn: 2 });
    expect(beatState(state, "landmine-L2")?.questions).toBe(2);
    expect(beatState(state, "landmine-L2")?.status).toBe("dodged");
    expect(isRepeatLine(state, { beat_id: "responsibility", say: L514 })).toBe(true);
  });
});

describe("brief 18b: at most one interrupt per beat", () => {
  it("canInterruptBeat is false after one interrupt, on spent beats, and true otherwise", () => {
    const state = createInterviewState(buildFallbackPlan(cafeTestScenario));
    const first = state.plan.beats[0]!;
    expect(canInterruptBeat(state, first.id)).toBe(true);
    applyInterruptLine(state, "[interrupting] Sorry, when did you know?", { turn: 1 });
    expect(canInterruptBeat(state, first.id)).toBe(false);
    expect(canInterruptBeat(state, state.plan.beats[1]!.id)).toBe(true);
    // Unknown beat ids stay permissive (no state to protect).
    expect(canInterruptBeat(state, "no-such-beat")).toBe(true);
  });
});

describe("brief 18b: brain retries a mislabelled repeat, then falls back", () => {
  const prompts: JournalistPrompts = {
    spokenStyle: "STYLE",
    journalistTurn: "PLAN {interview_plan} ACTIVE {active_beat} DIR {directive} ASKED {asked_lines} EST {established} FULL {full_transcript} {last_answer} {spoken_style} {public_facts} {landmines_known_to_you}",
    openingQuestion: "O",
  };
  const mislabelled = JSON.stringify({ move: "follow_up", flags: [], say: L514, quote_used: null, beat_id: "responsibility" });

  it("a screening-form line labelled responsibility is a repeat of spent L2", async () => {
    let calls = 0;
    const llm = {
      chat: async () => { calls += 1; return { text: mislabelled, model: "m", finishReason: null }; },
      generateStructured: async () => { throw new Error("unused"); },
    };
    const brain = new JournalistBrain(llm as never, prompts);
    const fallback = line({ beat_id: "action", say: "What exactly will you do next, and by when?" });
    const result = await brain.nextTurn(cafeTestScenario, [], "We acted fast", 60, undefined, [], {
      planLines: "- landmine-L2 [exhausted] screening form",
      activeBeatLine: "action: what changes",
      directive: "MOVE_ON: beat exhausted",
      nextBeatGoal: "Concrete action",
      established: [], commitments: [], openThreads: [],
      asked: [L339],
      askedBeats: ["landmine-L2"],
      closedBeatIds: ["landmine-L2"],
      spentBeatIds: ["landmine-L2"],
      landmineFacts: [{ beatId: "landmine-L2", fact: SCREENING_FACT }],
      callbackBeatId: null, fallbackLine: fallback,
    });
    expect(calls).toBe(2); // one retry, no elevated retries
    expect(result.say).toBe(fallback.say);
    expect(result.beat_id).toBe("action");
  });

  it("the same-beat open parents lines are not a repeat", async () => {
    const say = "Will every parent have that in writing by eight tonight?";
    let calls = 0;
    const llm = {
      chat: async () => { calls += 1; return { text: JSON.stringify({ move: "follow_up", flags: [], say, quote_used: null, beat_id: "action" }), model: "m", finishReason: null }; },
      generateStructured: async () => { throw new Error("unused"); },
    };
    const brain = new JournalistBrain(llm as never, prompts);
    const fallback = line({ beat_id: "close", say: "One last thing. What should people remember about this?" });
    const result = await brain.nextTurn(cafeTestScenario, [], "We will write", 60, undefined, [], {
      planLines: "- action [active] what changes",
      activeBeatLine: "action: what changes",
      directive: "PUSH: active beat not done",
      nextBeatGoal: "Concrete action",
      established: [], commitments: [], openThreads: [],
      asked: ["What will you send parents in writing by eight tonight?"],
      askedBeats: ["action"],
      closedBeatIds: [],
      spentBeatIds: [],
      landmineFacts: [],
      callbackBeatId: null, fallbackLine: fallback,
    });
    expect(calls).toBe(1);
    expect(result.say).toBe(say);
  });
});
