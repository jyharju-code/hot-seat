/** Adaptive turn-end silence. People think aloud under pressure, so an
 *  answer that looks unfinished gets a longer silence before the turn ends.
 *  Deterministic and pure so it can be unit tested. */

export const TURN_END_SILENCE_MS = 1000;
export const TURN_END_HESITANT_MS = 3200;

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
 * waits the cap. The word heuristic decides only when the call failed
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
  if (spec !== null && typeof spec === "object") {
    if (spec.kind === "pending") return hesitant;
    if (spec.kind === "failed") return heuristic();
    if (spec.ownerDone === true) return complete;
    if (spec.ownerDone === false) return hesitant;
    return heuristic();
  }
  if (spec === "failed") return heuristic();
  if (spec === true) return complete;
  if (spec === false) return hesitant;
  return heuristic();
}
