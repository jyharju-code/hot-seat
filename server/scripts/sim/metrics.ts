/** Pure turn metrics for the synthetic-owner sim. No I/O, unit tested. */

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function normalizeText(text: string): string {
  return normalizeWords(text).join(" ");
}

/** Word-level Levenshtein distance. */
export function wordDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** WER of the server transcript (hypothesis) against the spoken text (reference). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordDistance(ref, hyp) / ref.length;
}

/** Normalised similarity in [0, 1]: 1 minus word distance over the longer text. */
export function textSimilarity(a: string, b: string): number {
  const wa = normalizeWords(a);
  const wb = normalizeWords(b);
  if (wa.length === 0 || wb.length === 0) return wa.length === wb.length ? 1 : 0;
  return 1 - wordDistance(wa, wb) / Math.max(wa.length, wb.length);
}

/** The reporter asked essentially the same question as in the previous turn. */
export function isRepeat(previous: string, current: string, threshold = 0.8): boolean {
  if (!normalizeText(previous) || !normalizeText(current)) return false;
  return textSimilarity(previous, current) > threshold;
}

export interface SplitInput {
  /** User transcripts attributed to this one spoken answer. */
  transcriptCount: number;
  /** When the first user transcript for this answer arrived, or null. */
  firstTranscriptAtMs: number | null;
  /** When the owner's last speech frame was sent. */
  speechEndMs: number;
}

/** One answer arrived as more than one transcript, or its transcript closed before the owner finished speaking. */
export function detectSplit(input: SplitInput): boolean {
  if (input.transcriptCount > 1) return true;
  return input.firstTranscriptAtMs !== null && input.firstTranscriptAtMs < input.speechEndMs;
}

/** Strip the server's interrupt marker before comparing texts. */
export function stripCutOff(text: string): string {
  return text.replace(/\s*\(cut off\)\s*$/, "").trim();
}

export function wordCount(text: string): number {
  return normalizeWords(text).length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function worst(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}
