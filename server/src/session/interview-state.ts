import { isProfileScenario, type AnswerAssessment, type BeatStatus, type Commitment, type EstablishedFact, type GeneratedScenario, type InterviewBeat, type InterviewMapRow, type InterviewPlan, type ReporterLine } from "@hot-seat/shared";
import type { BrainScenario } from "../journalist.js";
import { isGenerated } from "../journalist.js";

export type { InterviewBeat, InterviewPlan, BeatStatus };
export type DirectiveType = "PUSH" | "MOVE_ON" | "CALLBACK";
export interface Directive {
  type: DirectiveType;
  activeBeat: InterviewBeat | null;
  nextBeat: InterviewBeat | null;
  reason: string;
}

export interface InterviewState {
  plan: InterviewPlan;
  beats: Array<{ beat: InterviewBeat; status: BeatStatus; questions: number }>;
  established: EstablishedFact[];
  commitments: Commitment[];
  open_threads: string[];
  asked: string[];
  callbackUsed: boolean;
  callbackBeatId: string | null;
  repeatCount: number;
  /** beat_id per committed reporter line, for sim metrics. */
  servedBeats: string[];
  turn: number;
}

const CLOSED: BeatStatus[] = ["answered", "dodged", "exhausted"];
export const isClosedStatus = (s: BeatStatus) => CLOSED.includes(s);

function scenarioParts(scenario: BrainScenario) {
  if (isGenerated(scenario)) {
    return {
      profile: isProfileScenario(scenario),
      headline: scenario.crisis.headline,
      summary: scenario.crisis.summary,
      timeline: scenario.crisis.timeline,
      stakes: scenario.crisis.stakes,
      company: scenario.company.name,
      landmines: scenario.landmines,
      agenda: scenario.journalists[0]?.agenda ?? "",
      temperament: scenario.journalists[0]?.temperament ?? "",
      publicFacts: scenario.public_facts,
    };
  }
  return { profile: false, headline: scenario.title, summary: scenario.brief, timeline: [] as string[], stakes: "", company: scenario.businessName, landmines: [] as GeneratedScenario["landmines"], agenda: scenario.reporter.agenda, temperament: scenario.reporter.temperament, publicFacts: scenario.publicFacts };
}

/** Deterministic fallback plan built in code from the scenario. Never throws. */
export function buildFallbackPlan(scenario: BrainScenario): InterviewPlan {
  const s = scenarioParts(scenario);
  if (s.profile) {
    const beats: InterviewBeat[] = [
      { id: "origin", goal: `Why and how ${s.company} started`, done_when: "Owner tells how it began and why", max_questions: 3, kind: "origin" },
      { id: "business_today", goal: `What ${s.company} is like today`, done_when: "Owner describes the business today: customers, staff, what sells", max_questions: 3, kind: "business_today" },
      { id: "hard_years", goal: "The hard years and what they cost", done_when: "Owner names a hard period and what got them through", max_questions: 3, kind: "hard_years" },
      { id: "people", goal: "The people: staff, partners, customers", done_when: "Owner talks concretely about named people", max_questions: 3, kind: "people" },
      { id: "future", goal: "What comes next for the business", done_when: "Owner states a concrete hope or plan for the future", max_questions: 2, kind: "future" },
      { id: "close", goal: "Close warmly and thank the owner", done_when: "Reporter thanks the owner and closes", max_questions: 2, kind: "close" },
    ];
    return { beats };
  }
  const humanFirst = s.temperament === "human";
  const facts: InterviewBeat = { id: "facts", goal: `What happened: ${s.headline}`, done_when: "Owner gives their account of what happened and when", max_questions: 3, kind: "facts" };
  const responsibility: InterviewBeat = { id: "responsibility", goal: "Who is responsible and what the owner knew", done_when: "Owner states their own role plainly, an admission counts", max_questions: 3, kind: "responsibility" };
  const landmineBeats: InterviewBeat[] = s.landmines.map((m) => ({
    id: `landmine-${m.id}`,
    goal: `Confront: ${m.fact}`,
    done_when: `Owner answers about: ${m.fact}`,
    max_questions: 2,
    kind: "landmine",
    landmine_id: m.id,
    ...(m.reveal_after_seconds > 0 ? { unlock_at_seconds: m.reveal_after_seconds } : {}),
  }));
  const human: InterviewBeat = { id: "human_impact", goal: `Human impact on named people affected by: ${s.stakes || s.summary}`, done_when: "Owner addresses the affected people by name and what they say to them", max_questions: 2, kind: "human_impact" };
  const action: InterviewBeat = { id: "action", goal: "Concrete action with a deadline: what changes and by when", done_when: "Owner commits to a specific action with a day or time", max_questions: 3, kind: "action" };
  const close: InterviewBeat = { id: "close", goal: "Close the interview", done_when: "Reporter closes with a final question or statement", max_questions: 2, kind: "close" };
  let ordered: InterviewBeat[];
  if (humanFirst) ordered = [human, facts, responsibility, ...landmineBeats, action, close];
  else ordered = [facts, responsibility, ...landmineBeats, human, action, close];
  // Keep 5..7 beats: drop the separate human beat first (action still asks
  // who is affected), then merge facts+responsibility if still too many.
  while (ordered.length > 7) {
    const idx = ordered.findIndex((b) => b.kind === "human_impact");
    if (idx >= 0) { ordered.splice(idx, 1); continue; }
    const merged: InterviewBeat = { id: "facts", goal: `What happened and who is responsible: ${s.headline}`, done_when: "Owner gives their account and states their own role; an admission counts", max_questions: 3, kind: "facts" };
    ordered = ordered.filter((b) => b.id !== "facts" && b.id !== "responsibility");
    ordered.splice(humanFirst ? 1 : 0, 0, merged);
  }
  while (ordered.length < 5) ordered.splice(ordered.length - 1, 0, { id: `extra-${ordered.length}`, goal: s.agenda || "Follow the reporter's agenda", done_when: "Owner answers the agenda question", max_questions: 2, kind: "facts" });
  return { beats: ordered };
}
export const fallbackPlan = buildFallbackPlan;
export const buildDeterministicFallbackPlan = buildFallbackPlan;

export function createInterviewState(plan: InterviewPlan): InterviewState {
  return {
    plan,
    beats: plan.beats.map((beat, i) => ({ beat, status: i === 0 ? "active" : "open", questions: 0 })),
    established: [], commitments: [], open_threads: [], asked: [], callbackUsed: false, callbackBeatId: null, repeatCount: 0, servedBeats: [], turn: 0,
  };
}
export const createState = createInterviewState;

export function eligibleBeats(state: InterviewState, elapsedSeconds: number) {
  return state.beats.filter((b) => !isClosedStatus(b.status) && (b.beat.unlock_at_seconds ?? 0) <= elapsedSeconds);
}
export function activeBeat(state: InterviewState, elapsedSeconds = 0): InterviewBeat | null {
  const active = state.beats.find((b) => b.status === "active" && (b.beat.unlock_at_seconds ?? 0) <= elapsedSeconds);
  if (active) return active.beat;
  return eligibleBeats(state, elapsedSeconds)[0]?.beat ?? null;
}
export function beatState(state: InterviewState, beatId: string | undefined) {
  return beatId ? state.beats.find((b) => b.beat.id === beatId) : undefined;
}
export function isClosedBeat(state: InterviewState, beatId: string | undefined): boolean {
  const b = beatState(state, beatId);
  return b ? isClosedStatus(b.status) : false;
}
/** A line serving a closed beat is a repeat, unless it is the one allowed CALLBACK. */
export function isRepeatLine(state: InterviewState, line: Pick<ReporterLine, "beat_id">, opts: { isCallback?: boolean } = {}): boolean {
  if (!line.beat_id) return false;
  if (!isClosedBeat(state, line.beat_id)) return false;
  if (opts.isCallback && !state.callbackUsed) return false;
  return true;
}

export interface DirectiveOptions {
  elapsedSeconds?: number;
  durationSeconds?: number;
  escalationBeatId?: string | null;
  contradictionBeatId?: string | null;
}

export function computeDirective(state: InterviewState, opts: DirectiveOptions = {}): Directive {
  const elapsed = opts.elapsedSeconds ?? 0;
  const eligible = eligibleBeats(state, elapsed);
  // Escalation puts its beat first.
  if (opts.escalationBeatId) {
    const esc = eligible.find((b) => b.beat.id === opts.escalationBeatId || b.beat.landmine_id === opts.escalationBeatId);
    if (esc) return { type: "MOVE_ON", activeBeat: esc.beat, nextBeat: esc.beat, reason: "escalation" };
  }
  // Single CALLBACK for a real contradiction.
  if (opts.contradictionBeatId && !state.callbackUsed) {
    const cb = state.beats.find((b) => b.beat.id === opts.contradictionBeatId && isClosedStatus(b.status));
    if (cb) return { type: "CALLBACK", activeBeat: activeBeat(state, elapsed), nextBeat: cb.beat, reason: "contradiction with established facts" };
  }
  const explicitActive = state.beats.find((b) => b.status === "active");
  const current = explicitActive ?? eligible[0];
  if (!current) return { type: "MOVE_ON", activeBeat: null, nextBeat: null, reason: "no eligible beats" };
  if (!explicitActive && state.beats.some((b) => isClosedStatus(b.status))) {
    return { type: "MOVE_ON", activeBeat: current.beat, nextBeat: current.beat, reason: "previous beat closed" };
  }
  if (isClosedStatus(current.status) || current.questions >= current.beat.max_questions) {
    const next = eligible.find((b) => b.beat.id !== current.beat.id) ?? null;
    return { type: "MOVE_ON", activeBeat: current.beat, nextBeat: next?.beat ?? null, reason: current.questions >= current.beat.max_questions ? "max_questions reached" : "beat closed" };
  }
  // Pacing: each beat gets its share; profile must touch all beats before wrap-up.
  const duration = opts.durationSeconds ?? 0;
  if (duration > 0) {
    const remainingBeats = state.beats.filter((b) => !isClosedStatus(b.status));
    const remainingTime = Math.max(0, duration - elapsed);
    const share = remainingBeats.length > 0 ? remainingTime / remainingBeats.length : 0;
    const idx = state.beats.indexOf(current);
    // Absolute share check: past this beat's fair slice of total time.
    const fairEnd = ((idx + 1) / Math.max(1, state.beats.length)) * duration;
    if (elapsed > fairEnd && share >= 0) {
      const next = eligible.find((b) => b.beat.id !== current.beat.id) ?? null;
      return { type: "MOVE_ON", activeBeat: current.beat, nextBeat: next?.beat ?? null, reason: "pacing: over its share of remaining time" };
    }
  }
  return { type: "PUSH", activeBeat: current.beat, nextBeat: current.beat, reason: "active beat not done" };
}
export const directiveFor = computeDirective;

function shortLine(text: string): string {
  const t = text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
}

/**
 * Update state ONLY from a committed line. Speculative/aborted lines must
 * never call this. Returns the state (mutated).
 */
export function applyCommittedLine(state: InterviewState, line: ReporterLine, opts: { turn?: number; elapsedSeconds?: number; isCallback?: boolean } = {}): InterviewState {
  const turn = opts.turn ?? state.turn + 1;
  state.turn = turn;
  // Repeat accounting: serving a closed beat (excluding sanctioned callback).
  if (line.beat_id && isClosedBeat(state, line.beat_id) && !(opts.isCallback && !state.callbackUsed)) {
    state.repeatCount += 1;
  }
  if (opts.isCallback && line.beat_id) { state.callbackUsed = true; state.callbackBeatId = line.beat_id; }
  // Determine the beat this line serves: declared, else current active.
  const elapsed = opts.elapsedSeconds ?? 0;
  const targetId = line.beat_id ?? activeBeat(state, elapsed)?.id;
  const target = beatState(state, targetId ?? undefined);
  if (target && !isClosedStatus(target.status)) {
    target.status = "active";
    target.questions += 1;
    for (const b of state.beats) if (b !== target && b.status === "active") b.status = "open";
  }
  state.asked.push(shortLine(line.say));
  if (targetId) state.servedBeats.push(targetId);
  // Assessment of owner's last answer applies to the beat that was active
  // before this line: use target's predecessor logic via assessment field.
  const assessment: AnswerAssessment | undefined = line.answer_assessment;
  // The assessed beat is the beat the previous question served: last served before this one.
  const prevBeatId = state.servedBeats.length >= 2 ? state.servedBeats[state.servedBeats.length - 2] : targetId;
  // Simpler and predictable: assessment closes the beat it was asked on, which
  // is tracked as the beat served by previous line; if only one, target.
  const assessed = beatState(state, prevBeatId ?? undefined) ?? target;
  if (assessment && assessed) {
    if (assessment === "answered") assessed.status = "answered";
    else if (assessment === "dodged" && assessed.questions >= assessed.beat.max_questions) assessed.status = "dodged";
  }
  // Admission counts as answered: strong_answer flag or answered assessment.
  if (line.flags?.includes("strong_answer") && assessed && assessment !== "dodged") {
    // Only a genuine admission/strong answer on that beat closes it if assessed as answered/partial handled below.
  }
  if (target && target.questions >= target.beat.max_questions && !isClosedStatus(target.status)) {
    target.status = assessment === "dodged" ? "dodged" : "exhausted";
  }
  // If assessed beat answered, activate next eligible.
  if (assessed && assessed.status === "answered") {
    const next = state.beats.find((b) => !isClosedStatus(b.status) && (b.beat.unlock_at_seconds ?? 0) <= elapsed) ?? state.beats.find((b) => !isClosedStatus(b.status));
    if (next && next !== target) { /* next becomes active on next directive; keep target active if it is the new line's beat */ }
    if (target && isClosedStatus(target.status)) {
      const nxt = state.beats.find((b) => !isClosedStatus(b.status));
      if (nxt) nxt.status = "active";
    }
  }
  for (const f of line.new_established ?? []) {
    const text = f.trim();
    if (text && !state.established.some((e) => e.text.toLowerCase() === text.toLowerCase())) state.established.push({ text, turn });
  }
  if (line.new_commitment?.trim()) state.commitments.push({ text: line.new_commitment.trim(), turn });
  if (line.new_open_thread?.trim() && !state.open_threads.includes(line.new_open_thread.trim())) state.open_threads.push(line.new_open_thread.trim());
  return state;
}
export const applyCommittedTurn = applyCommittedLine;
export const updateFromCommittedLine = applyCommittedLine;

/** Deterministic transition question for a beat (fallback when model repeats). */
export function transitionQuestionForBeat(beat: InterviewBeat): ReporterLine {
  const goal = beat.goal.replace(/^Confront:\s*/i, "");
  const say = beat.kind === "close" ? "One last thing before we finish. What should people remember about this?"
    : beat.kind === "action" ? "What exactly will you do next, and by when?"
    : beat.kind === "human_impact" ? "What do you say to the people affected by this?"
    : `Let's move on. ${goal.charAt(0).toUpperCase()}${goal.slice(1)}?`;
  return { move: "new_angle", flags: [], say, quote_used: null, beat_id: beat.id };
}
export const transitionLineForBeat = transitionQuestionForBeat;

export function interviewMap(state: InterviewState): InterviewMapRow[] {
  return state.beats.map((b) => ({ id: b.beat.id, goal: b.beat.goal, status: b.status, questions: b.questions, kind: b.beat.kind }));
}

export function formatInterviewMapForDebrief(state: InterviewState): string {
  return state.beats.map((b) => `- ${b.beat.id} (${b.beat.kind}): ${b.beat.goal} | status=${b.status} | questions=${b.questions}`).join("\n");
}

export interface InterviewSimMetrics { beatsTouched: string[]; finalStatuses: Record<string, BeatStatus>; repeatCount: number; longestRun: number }
export function interviewSimMetrics(state: InterviewState): InterviewSimMetrics {
  let longest = 0, run = 0, prev: string | null = null;
  for (const id of state.servedBeats) { run = id === prev ? run + 1 : 1; prev = id; longest = Math.max(longest, run); }
  return {
    beatsTouched: [...new Set(state.servedBeats)],
    finalStatuses: Object.fromEntries(state.beats.map((b) => [b.beat.id, b.status])),
    repeatCount: state.repeatCount,
    longestRun: longest,
  };
}
export const simMetricsForState = interviewSimMetrics;

/** Snapshot safe to store on a session record. */
export function snapshotState(state: InterviewState) {
  return {
    plan: state.plan,
    beats: state.beats.map((b) => ({ id: b.beat.id, goal: b.beat.goal, kind: b.beat.kind, status: b.status, questions: b.questions })),
    established: [...state.established], commitments: [...state.commitments], open_threads: [...state.open_threads], asked: [...state.asked],
    callbackUsed: state.callbackUsed, repeatCount: state.repeatCount, servedBeats: [...state.servedBeats],
  };
}
export type InterviewSnapshot = ReturnType<typeof snapshotState>;
