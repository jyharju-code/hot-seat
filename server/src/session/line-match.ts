/**
 * Cheap text matching for the interview repeat guard (brief 18b). No model
 * calls: normalised content-word overlap plus shared key phrases.
 *
 * Pure string functions only, so both the interview state
 * (`interview-state.ts`) and the journalist brain (`journalist.ts`) can use
 * them without an import cycle.
 */

/** Words that carry no topic: articles, pronouns, auxiliaries, question words. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than", "that", "this",
  "these", "those", "it", "its", "he", "him", "his", "she", "her", "they", "them",
  "their", "we", "us", "our", "ours", "you", "your", "yours", "i", "me", "my",
  "mine", "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "doing", "done", "have", "has", "had", "having", "will", "would", "shall",
  "should", "can", "could", "may", "might", "must", "ought", "need", "not", "no",
  "never", "very", "just", "really", "quite", "too", "also", "even", "still",
  "yet", "already", "again", "ever", "always", "often", "here", "there", "now",
  "today", "every", "each", "all", "any", "some", "such", "own", "other", "one",
  "two", "about", "above", "after", "against", "along", "among", "around",
  "as", "at", "before", "behind", "below", "between", "by", "down", "during",
  "for", "from", "in", "into", "like", "near", "of", "off", "on", "onto",
  "out", "over", "through", "to", "toward", "under", "until", "up", "upon",
  "with", "within", "without", "as", "per", "via", "although", "though",
  "well", "oh", "uh", "um", "please", "let", "lets", "tell",
]);

/** Lowercase, strip audio tags, punctuation and stop words. */
export function contentWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/** Consecutive content-word pairs: the "key noun phrases" of a line. */
export function contentBigrams(text: string): Set<string> {
  const words = contentWords(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Normalised reporter text for identity comparison (matches interview-state). */
export function normalizeLine(text: string): string {
  return text.replace(/\[[^\]]*\]/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Jaccard similarity of the two lines' content-word sets. 0 when either is empty. */
export function overlapScore(a: string, b: string): number {
  const setA = new Set(contentWords(a));
  const setB = new Set(contentWords(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/** Two lines share at least one consecutive content-word pair. */
export function sharesKeyPhrase(a: string, b: string): boolean {
  const phrasesA = contentBigrams(a);
  if (phrasesA.size === 0) return false;
  const phrasesB = contentBigrams(b);
  for (const p of phrasesA) if (phrasesB.has(p)) return true;
  return false;
}

/** Jaccard at or above this counts as the same question by text. */
export const LINE_OVERLAP_THRESHOLD = 0.5;

/**
 * True when two reporter lines ask the same thing by text: high content-word
 * overlap, or the same key noun phrase (for example "screening form").
 */
export function linesMatchText(a: string, b: string): boolean {
  if (overlapScore(a, b) >= LINE_OVERLAP_THRESHOLD) return true;
  return sharesKeyPhrase(a, b);
}

export interface LineMatchContext {
  /** Every earlier reporter line, interrupts included, oldest first. */
  asked: readonly string[];
  /** Beat each asked line served, parallel to `asked`. */
  askedBeats: ReadonlyArray<string | undefined>;
  /** Distinctive landmine facts for label repair. */
  landmineFacts: ReadonlyArray<{ beatId: string; fact: string }>;
}

/**
 * The beat a line really serves, regardless of the model's `beat_id` label.
 * A line sharing a key phrase with a landmine fact serves that landmine's
 * beat; otherwise a line matching an earlier line from another beat serves
 * that earlier beat. Returns the declared beat (or undefined) when nothing
 * better matches.
 */
export function resolveEffectiveBeatId(
  say: string,
  declaredBeatId: string | undefined,
  ctx: LineMatchContext,
): string | undefined {
  if (say.trim().length > 0) {
    // Label repair: the declared landmine beat keeps its line when the line
    // matches its own fact, so landmines never steal from each other.
    const declaredFact = declaredBeatId
      ? ctx.landmineFacts.find((m) => m.beatId === declaredBeatId)
      : undefined;
    if (declaredFact && sharesKeyPhrase(declaredFact.fact, say)) return declaredBeatId;
    for (const m of ctx.landmineFacts) {
      if (m.beatId !== declaredBeatId && sharesKeyPhrase(m.fact, say)) return m.beatId;
    }
    let best: string | undefined;
    let bestScore = 0;
    const normalized = normalizeLine(say);
    for (let i = 0; i < ctx.asked.length; i++) {
      const beatId = ctx.askedBeats[i];
      if (!beatId || beatId === declaredBeatId) continue;
      const earlier = ctx.asked[i]!;
      // A verbatim duplicate is an exact repeat, not a paraphrase of another
      // beat: the exact-text guard owns it, so it never reassigns attribution.
      if (normalizeLine(earlier) === normalized) continue;
      if (!linesMatchText(say, earlier)) continue;
      const score = overlapScore(say, earlier);
      if (score > bestScore || (score === bestScore && best === undefined)) {
        best = beatId;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return declaredBeatId;
}
