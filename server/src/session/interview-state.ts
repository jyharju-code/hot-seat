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

const PROFILE_KINDS = new Set(["origin", "business_today", "hard_years", "people", "future", "close"]);
export const isProfileBeat = (beat: InterviewBeat) => PROFILE_KINDS.has(beat.kind);

/** Brief 17b: profile content beats need 2 questions, everything else 1. */
export function minQuestionsForBeat(beat: InterviewBeat): number {
  if (beat.min_questions) return beat.min_questions;
  return isProfileBeat(beat) && beat.kind !== "close" ? 2 : 1;
}
export const beatMinQuestions = minQuestionsForBeat;

/** Normalised reporter text for the never-repeat check. */
export function normalizeLineText(text: string): string {
  return text.replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
export function isAlreadyAsked(asked: readonly string[], say: string): boolean {
  const n = normalizeLineText(say);
  if (!n) return false;
  return asked.some((a) => normalizeLineText(a) === n);
}

/** Beat-specific deterministic transition questions, warm (profile) or sharp (hot seat). */
export function fallbackLinesForBeat(beat: InterviewBeat): string[] {
  if (beat.fallback_lines && beat.fallback_lines.length > 0) return [...beat.fallback_lines];
  switch (beat.kind) {
    case "origin": return ["How did it all begin for you?", "What made you want to start this place?", "What do you remember most about those very first days?"];
    case "business_today": return ["What is a normal day here like now?", "Who comes through the door these days?", "What are people loving most at the moment?"];
    case "hard_years": return ["Were there times you nearly gave up?", "What was the hardest stretch, looking back?", "What kept you going when it got tough?"];
    case "people": return ["Tell me about the people who make this place work.", "Who has been with you the longest?", "What are your regulars like?"];
    case "future": return ["What would you love to do next?", "Where do you hope this place is in five years?", "What is the dream from here?"];
    case "close": return isProfileBeat(beat) ? ["Is there anything else you would love people to know?", "What has this anniversary meant to you?"] : ["One last thing. What should people remember about this?", "Final question. What do you want readers to take away?"];
    case "facts": return ["Walk me through exactly what happened, step by step.", "When did you first know something was wrong?", "What happened next, in your own words?"];
    case "responsibility": return ["Who made that call, and when?", "What was your part in that decision?", "What did you know, and when did you know it?"];
    case "landmine": return [`About this: ${beat.goal.replace(/^Confront:\s*/i, "")}. What is your answer?`, "How do you explain that?", "Why did that not come out sooner?"];
    case "human_impact": return ["What do you say to the people affected by this?", "Name the person most affected. What have you said to them?", "What happens to them now?"];
    case "action": return ["What exactly will you do next, and by when?", "Give me a day and a time. What changes by then?", "What happens if you miss that deadline?"];
    default: return [`Tell me more about this: ${beat.goal}.`];
  }
}
export const transitionLinesForBeat = fallbackLinesForBeat;

/** Fill min_questions and fallback_lines on beats from any plan source. */
export function withBeatDefaults(plan: InterviewPlan): InterviewPlan {
  return { beats: plan.beats.map((b) => ({ ...b, min_questions: minQuestionsForBeat(b), fallback_lines: fallbackLinesForBeat(b) })) };
}

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
    return withBeatDefaults({ beats });
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
  return withBeatDefaults({ beats: ordered });
}
export const fallbackPlan = buildFallbackPlan;
export const buildDeterministicFallbackPlan = buildFallbackPlan;

export function createInterviewState(plan: InterviewPlan): InterviewState {
  const normalized = withBeatDefaults(plan);
  return {
    plan: normalized,
    beats: normalized.beats.map((beat, i) => ({ beat, status: i === 0 ? "active" : "open", questions: 0 })),
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
  isProfile?: boolean;
  wrapUpSeconds?: number;
}

export const PROFILE_WRAP_UP_SECONDS_LOCAL = 45;

/** True when this state is a profile interview (profile beat kinds present). */
export function isProfileState(state: InterviewState): boolean {
  return state.beats.some((b) => isProfileBeat(b.beat) && b.beat.kind !== "close");
}

/** Close beat is locked until duration minus wrapUpSeconds (profile only). */
export function isCloseLocked(state: InterviewState, elapsedSeconds: number, durationSeconds = 0, wrapUpSeconds = PROFILE_WRAP_UP_SECONDS_LOCAL): boolean {
  if (!isProfileState(state) || durationSeconds <= 0) return false;
  return elapsedSeconds < durationSeconds - wrapUpSeconds;
}

export function computeDirective(state: InterviewState, opts: DirectiveOptions = {}): Directive {
  const elapsed = opts.elapsedSeconds ?? 0;
  const duration = opts.durationSeconds ?? 0;
  const profile = opts.isProfile ?? isProfileState(state);
  const closeLocked = profile && duration > 0 && elapsed < duration - (opts.wrapUpSeconds ?? PROFILE_WRAP_UP_SECONDS_LOCAL);
  const allEligible = eligibleBeats(state, elapsed);
  const eligible = closeLocked ? allEligible.filter((b) => b.beat.kind !== "close") : allEligible;
  // Profile: all content beats done but close still locked, revisit people/threads.
  if (closeLocked && eligible.length === 0) {
    const people = state.beats.find((b) => b.beat.kind === "people") ?? state.beats.find((b) => b.beat.kind !== "close");
    if (people) return { type: "PUSH", activeBeat: people.beat, nextBeat: people.beat, reason: "revisit open threads before close" };
  }
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
  const explicitActive = state.beats.find((b) => b.status === "active" && !(closeLocked && b.beat.kind === "close") && !isClosedStatus(b.status));
  const current = explicitActive ?? eligible[0];
  if (!current) return { type: "MOVE_ON", activeBeat: null, nextBeat: null, reason: "no eligible beats" };
  if (!explicitActive && state.beats.some((b) => isClosedStatus(b.status))) {
    return { type: "MOVE_ON", activeBeat: current.beat, nextBeat: current.beat, reason: "previous beat closed" };
  }
  if (isClosedStatus(current.status) || current.questions >= current.beat.max_questions) {
    const next = eligible.find((b) => b.beat.id !== current.beat.id) ?? null;
    return { type: "MOVE_ON", activeBeat: current.beat, nextBeat: next?.beat ?? null, reason: current.questions >= current.beat.max_questions ? "max_questions reached" : "beat closed" };
  }
  // Brief 17b: a started beat below min_questions cannot close, pacing is a ceiling.
  if (current.questions >= 1 && current.questions < minQuestionsForBeat(current.beat)) {
    return { type: "PUSH", activeBeat: current.beat, nextBeat: current.beat, reason: "below min_questions" };
  }
  // Pacing: each beat gets its share; profile must touch all beats before wrap-up.
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
export function applyCommittedLine(state: InterviewState, line: ReporterLine, opts: { turn?: number; elapsedSeconds?: number; isCallback?: boolean; isRevisit?: boolean } = {}): InterviewState {
  const turn = opts.turn ?? state.turn + 1;
  state.turn = turn;
  // Repeat accounting: serving a closed beat (excluding sanctioned callback).
  if (line.beat_id && isClosedBeat(state, line.beat_id) && !opts.isRevisit && !(opts.isCallback && !state.callbackUsed)) {
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
    // Brief 17b: a beat cannot close as answered below its minimum.
    if (assessment === "answered" && assessed.questions >= minQuestionsForBeat(assessed.beat)) assessed.status = "answered";
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

export interface TransitionOptions {
  asked?: readonly string[];
  openThreads?: readonly string[];
  profile?: boolean;
}

/** Open-thread follow-up line, or null when every thread line was already asked. */
export function openThreadLine(state: InterviewState, asked: readonly string[] = state.asked): ReporterLine | null {
  for (const thread of state.open_threads) {
    const t = thread.trim().replace(/[.?!\s]+$/, "");
    if (!t) continue;
    const say = `You mentioned ${t.charAt(0).toLowerCase()}${t.slice(1)}. Tell me more about that.`;
    if (!isAlreadyAsked(asked, say)) {
      const people = state.beats.find((b) => b.beat.kind === "people");
      return { move: "follow_up", flags: [], say, quote_used: null, ...(people ? { beat_id: people.beat.id } : {}) };
    }
  }
  return null;
}

/** Names mentioned in open threads / established facts, for the people revisit. */
export function mentionedPeople(state: InterviewState): string[] {
  const names: string[] = [];
  const text = [...state.open_threads, ...state.established.map((e) => e.text)].join(". ");
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s(?:and\s)?[A-Z][a-z]+)?)\b/g)) {
    const raw = m[1]!.trim();
    for (const part of raw.split(/\s+and\s+|\s+/)) {
      const name = part.trim();
      if (name.length >= 3 && !["The", "You", "What", "When", "Owner"].includes(name) && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 3);
}

/** Profile revisit when content beats are done but close is still locked. */
export function revisitLine(state: InterviewState, asked: readonly string[] = state.asked): ReporterLine {
  const thread = openThreadLine(state, asked);
  if (thread) return thread;
  const people = state.beats.find((b) => b.beat.kind === "people");
  const names = mentionedPeople(state);
  const candidates = [
    ...(names.length >= 2
      ? [`You mentioned ${names.slice(0, 2).join(" and ")}. What are they like to work with?`]
      : names.length === 1
        ? [`You mentioned ${names[0]}. What are they like to work with?`]
        : []),
    "What are the people around this place like to work with?",
    ...(people ? fallbackLinesForBeat(people.beat) : []),
  ];
  for (const say of candidates) {
    if (!isAlreadyAsked(asked, say)) return { move: "follow_up", flags: [], say, quote_used: null, ...(people ? { beat_id: people.beat.id } : {}) };
  }
  return { move: "follow_up", flags: [], say: "Tell me more about that.", quote_used: null, ...(people ? { beat_id: people.beat.id } : {}) };
}

/**
 * Deterministic transition question for a beat (fallback when model repeats).
 * Beat-specific, never repeats a line already in `asked`: falls back to an
 * open thread, then to the profile generic or the hot-seat close.
 */
export function transitionQuestionForBeat(beat: InterviewBeat, opts: TransitionOptions & { state?: InterviewState } = {}): ReporterLine {
  const asked = opts.asked ?? opts.state?.asked ?? [];
  for (const say of fallbackLinesForBeat(beat)) {
    if (!isAlreadyAsked(asked, say)) return { move: "new_angle", flags: [], say, quote_used: null, beat_id: beat.id };
  }
  if (opts.state) {
    const thread = openThreadLine(opts.state, asked);
    if (thread) return thread;
  } else if (opts.openThreads && opts.openThreads.length > 0) {
    for (const thread of opts.openThreads) {
      const t = thread.trim().replace(/[.?!\s]+$/, "");
      if (!t) continue;
      const say = `You mentioned ${t.charAt(0).toLowerCase()}${t.slice(1)}. Tell me more about that.`;
      if (!isAlreadyAsked(asked, say)) return { move: "follow_up", flags: [], say, quote_used: null, beat_id: beat.id };
    }
  }
  const profile = opts.profile ?? isProfileBeat(beat);
  if (profile) return { move: "follow_up", flags: [], say: "Tell me more about that.", quote_used: null, beat_id: beat.id };
  // Hot seat, plan exhausted for this beat: close instead of inventing topics.
  return { move: "new_angle", flags: [], say: "One last thing. What should people remember about this?", quote_used: null, beat_id: beat.id };
}
export const transitionLineForBeat = transitionQuestionForBeat;

/** Next deterministic line for a state: directive target, revisit, or close. */
export function nextFallbackLine(state: InterviewState, opts: DirectiveOptions = {}): ReporterLine {
  const elapsed = opts.elapsedSeconds ?? 0;
  const duration = opts.durationSeconds ?? 0;
  const profile = opts.isProfile ?? isProfileState(state);
  if (profile && duration > 0 && isCloseLocked(state, elapsed, duration, opts.wrapUpSeconds ?? PROFILE_WRAP_UP_SECONDS_LOCAL)) {
    const contentOpen = state.beats.some((b) => b.beat.kind !== "close" && !isClosedStatus(b.status));
    if (!contentOpen) return revisitLine(state);
  }
  const directive = computeDirective(state, opts);
  const target = directive.type === "PUSH" ? directive.activeBeat : directive.nextBeat ?? directive.activeBeat;
  if (!target) {
    const close = state.beats.find((b) => b.beat.kind === "close");
    if (close) return transitionQuestionForBeat(close.beat, { asked: state.asked, state, profile });
    return profile
      ? { move: "follow_up", flags: [], say: "Tell me more about that.", quote_used: null }
      : { move: "new_angle", flags: [], say: "One last thing. What should people remember about this?", quote_used: null };
  }
  if (profile && isClosedStatus(beatState(state, target.id)?.status ?? "open") && directive.reason.includes("revisit")) return revisitLine(state);
  return transitionQuestionForBeat(target, { asked: state.asked, state, profile });
}
export const pickFallbackLine = nextFallbackLine;

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
