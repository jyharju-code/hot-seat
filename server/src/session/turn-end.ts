/** Adaptive turn-end silence. People think aloud under pressure, so an
 *  answer that looks unfinished gets a longer silence before the turn ends.
 *  Deterministic and pure so it can be unit tested. */

export const TURN_END_SILENCE_MS = 1400;
export const TURN_END_HESITANT_MS = 3200;
/** A partial unchanged for this long starts the speculative turn call. */
export const PARTIAL_STABLE_MS = 450;
/** Hard cap from the last speech activity to ending the turn (brief 11). */
export const TURN_CAP_MS = 4000;

/** Silence window capped so the turn ends by `capMs` after the last speech. */
export function cappedTurnEndSilenceMs(windowMs: number, sinceLastSpeechMs: number, capMs: number = TURN_CAP_MS): number {
  const remaining = capMs - Math.max(0, sinceLastSpeechMs);
  return Math.max(0, Math.min(windowMs, remaining));
}

/** Lowercase, punctuation removed, whitespace collapsed. */
export function normaliseTranscript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

/** True when two transcripts differ only in punctuation and casing. */
export function transcriptsMatchNormalised(a: string, b: string): boolean {
  return normaliseTranscript(a) === normaliseTranscript(b);
}

export function transcriptWordCount(text: string): number {
  const n = normaliseTranscript(text);
  return n ? n.split(" ").length : 0;
}

const SINGLE_FILLERS = new Set([
  "so",
  "and",
  "but",
  "because",
  "or",
  "um",
  "uh",
  "er",
  "like",
  "well",
]);

const PHRASE_FILLERS: readonly string[][] = [
  ["the", "thing", "is"],
  ["let", "me", "think"],
  ["i", "mean"],
  ["you", "know"],
];

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N},]+$/gu, ""))
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/,+$/, ""));
}

/** True when the answer so far looks unfinished: under 8 words, ending with
 *  a comma, or ending with a filler / unfinished-clause word or phrase. */
export function isHesitantAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith(",")) return true;
  const words = wordsOf(trimmed);
  if (words.length === 0) return false;
  if (words.length < 8) return true;
  const last = words[words.length - 1]!;
  if (SINGLE_FILLERS.has(last)) return true;
  for (const phrase of PHRASE_FILLERS) {
    if (words.length < phrase.length) continue;
    const tail = words.slice(words.length - phrase.length);
    if (phrase.every((w, i) => tail[i] === w)) return true;
  }
  return false;
}

export interface TurnEndOptions {
  silenceMs?: number;
  hesitantMs?: number;
}

/** Clear one-word replies to a yes/no question: the model's owner_done may
 *  end the turn at once for these even though they are under 8 words. */
const CLEAR_ONE_WORD_REPLIES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "no",
  "nope",
  "nah",
  "sure",
  "certainly",
  "absolutely",
  "correct",
  "right",
  "exactly",
  "agreed",
  "ok",
  "okay",
]);

/** True for a single-word answer that clearly replies to a yes/no question. */
export function isClearOneWordReply(text: string): boolean {
  return transcriptWordCount(text) === 1 && CLEAR_ONE_WORD_REPLIES.has(normaliseTranscript(text));
}

/**
 * True when the model's owner_done may shorten the wait to the normal
 * window: only for answers with at least 8 words, or a clear one-word
 * yes/no reply. Anything shorter usually means the owner paused mid-answer
 * to find words, so the hesitant window applies.
 */
export function ownerDoneShortensWait(answer: string): boolean {
  return transcriptWordCount(answer) >= 8 || isClearOneWordReply(answer);
}

/** State of the speculative turn call for the current answer. */
export type SpeculativeState =
  | { kind: "pending" }
  | { kind: "done"; ownerDone: boolean | null }
  | { kind: "failed" };

export type TurnEndSpec = boolean | null | undefined | "failed" | SpeculativeState;

/**
 * Silence to wait before ending the turn for this answer so far.
 * Brief 09d: the reporter cannot speak before the LLM result exists, so
 * waiting for `owner_done` costs no latency. While the speculative call
 * is pending, the only deadline is the hesitant cap (3200 ms). Once it
 * arrives, `owner_done: true` ends at the normal window and `false`
 * waits the cap. Brief 18: `owner_done: true` shortens the wait only for
 * answers with at least 8 words (or a clear one-word yes/no reply);
 * under 8 words it still waits the hesitant window, since a pause after
 * the first words usually means the owner is finding words, not finished.
 * The word heuristic decides only when the call failed
 * (or, for legacy boolean/null callers, when no judgement was given).
 */
export function turnEndSilenceMs(
  answer: string,
  opts: TurnEndOptions = {},
  spec?: TurnEndSpec,
): number {
  const complete = opts.silenceMs ?? TURN_END_SILENCE_MS;
  const hesitant = opts.hesitantMs ?? TURN_END_HESITANT_MS;
  const heuristic = () => (isHesitantAnswer(answer) ? hesitant : complete);
  const ownerDoneTrue = () => (ownerDoneShortensWait(answer) ? complete : hesitant);
  if (spec !== null && typeof spec === "object") {
    if (spec.kind === "pending") return hesitant;
    if (spec.kind === "failed") return heuristic();
    if (spec.ownerDone === true) return ownerDoneTrue();
    if (spec.ownerDone === false) return hesitant;
    return heuristic();
  }
  if (spec === "failed") return heuristic();
  if (spec === true) return ownerDoneTrue();
  if (spec === false) return hesitant;
  return heuristic();
}
