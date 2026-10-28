/** Soundbite location: word times from partials, fuzzy quote match, cut edges. */

export const PCM16_16K_BYTES_PER_MS = 32;
export const DEFAULT_ASR_LAG_MS = 350;
export const CUT_PAD_MS = 250;
export const SNAP_WINDOW_MS = 150;
export const SNAP_FRAME_MS = 20;

export interface WordTime {
  index: number;
  word: string;
  startMs: number;
}

export interface PartialObservation {
  text: string;
  /** Audio stream offset (ms of PCM sent) when this partial arrived. */
  audioOffsetMs: number;
}

export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean);
}

/** First-appearance time per word index, minus the calibrated ASR lag. */
export function buildWordTimes(
  partials: readonly PartialObservation[],
  lagMs: number = DEFAULT_ASR_LAG_MS,
): WordTime[] {
  const times: WordTime[] = [];
  for (const partial of partials) {
    const words = tokenize(partial.text);
    for (let i = 0; i < words.length; i++) {
      if (!times[i]) {
        times[i] = { index: i, word: words[i]!, startMs: Math.max(0, partial.audioOffsetMs - lagMs) };
      }
    }
  }
  return times.filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]!;
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i]!;
      dp[i] = Math.min(dp[i]! + 1, dp[i - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length]!;
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return d <= 1 ? 0.5 : 0;
}

export interface QuoteMatch {
  startWord: number;
  /** Exclusive. */
  endWord: number;
  score: number;
}

/** Fuzzy contiguous location of `quote` inside `turnText`. Null below threshold. */
export function fuzzyFindQuote(
  turnText: string,
  quote: string,
  threshold = 0.6,
): QuoteMatch | null {
  const turn = tokenize(turnText);
  const needle = tokenize(quote);
  if (needle.length === 0 || turn.length < needle.length) return null;
  let best: QuoteMatch | null = null;
  for (let start = 0; start + needle.length <= turn.length; start++) {
    let sum = 0;
    for (let i = 0; i < needle.length; i++) sum += tokenScore(turn[start + i]!, needle[i]!);
    const score = sum / needle.length;
    if (!best || score > best.score) best = { startWord: start, endWord: start + needle.length, score };
    if (score === 1) break;
  }
  return best && best.score >= threshold ? best : null;
}

export interface Cut {
  startMs: number;
  endMs: number;
}

/** Padded cut around the matched words, before snapping. */
export function computeCut(
  wordTimes: readonly WordTime[],
  match: QuoteMatch,
  turnEndMs: number,
  padMs: number = CUT_PAD_MS,
): Cut {
  const first = wordTimes[match.startWord];
  const after = wordTimes[match.endWord];
  const last = wordTimes[match.endWord - 1];
  const prev = wordTimes[match.endWord - 2];
  const rawStart = first ? first.startMs : 0;
  // No next word: estimate the last word's length from the previous gap.
  const estimatedLastMs = last && prev ? Math.max(200, last.startMs - prev.startMs) : 350;
  let rawEnd = after ? after.startMs : last ? last.startMs + estimatedLastMs : turnEndMs;
  if (rawEnd <= rawStart) rawEnd = rawStart + 400;
  return {
    startMs: Math.max(0, rawStart - padMs),
    endMs: Math.min(Math.max(turnEndMs, rawEnd), rawEnd + padMs),
  };
}

/** RMS of one PCM16 frame starting at byte offset. */
function frameRms(pcm: Uint8Array, byteStart: number, byteLen: number): number {
  let sum = 0;
  let n = 0;
  for (let i = byteStart; i + 1 < Math.min(pcm.length, byteStart + byteLen); i += 2) {
    const v = (pcm[i]! | (pcm[i + 1]! << 8)) << 16 >> 16;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Snap an edge to the quietest 20 ms frame within 150 ms. */
export function snapEdge(
  pcm: Uint8Array,
  sampleRate: number,
  targetMs: number,
  edge: "start" | "end",
): number {
  const bytesPerMs = (sampleRate / 1000) * 2;
  const frameBytes = Math.round(SNAP_FRAME_MS * bytesPerMs);
  const totalMs = pcm.length / bytesPerMs;
  let bestMs = Math.max(0, Math.min(totalMs, targetMs));
  let bestRms = Infinity;
  for (let ms = targetMs - SNAP_WINDOW_MS; ms <= targetMs + SNAP_WINDOW_MS; ms += SNAP_FRAME_MS) {
    const clamped = Math.max(0, Math.min(totalMs, ms));
    const rms = frameRms(pcm, Math.floor(clamped * bytesPerMs / 2) * 2, frameBytes);
    if (rms < bestRms) {
      bestRms = rms;
      bestMs = edge === "start" ? clamped : clamped + SNAP_FRAME_MS;
    }
  }
  return Math.max(0, Math.min(totalMs, Math.round(bestMs)));
}

export function snapCut(pcm: Uint8Array, sampleRate: number, cut: Cut): Cut {
  const startMs = snapEdge(pcm, sampleRate, cut.startMs, "start");
  let endMs = snapEdge(pcm, sampleRate, cut.endMs, "end");
  if (endMs <= startMs) endMs = Math.min(pcm.length / ((sampleRate / 1000) * 2), startMs + 100);
  return { startMs, endMs };
}

export function extractPcmSegment(pcm: Uint8Array, sampleRate: number, cut: Cut): Uint8Array {
  const bytesPerMs = (sampleRate / 1000) * 2;
  const start = Math.max(0, Math.floor(cut.startMs * bytesPerMs / 2) * 2);
  const end = Math.max(start, Math.min(pcm.length, Math.floor(cut.endMs * bytesPerMs / 2) * 2));
  return pcm.slice(start, end);
}

/** Linear-interpolation resample of PCM16 mono. */
export function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return pcm.slice();
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.round((inSamples * toRate) / fromRate);
  const out = new Uint8Array(outSamples * 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, inSamples * 2);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromRate) / toRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = pos - i0;
    const v = Math.round(view.getInt16(i0 * 2, true) * (1 - frac) + view.getInt16(i1 * 2, true) * frac);
    outView.setInt16(i * 2, v, true);
  }
  return out;
}

export function pcmDurationMs(byteLength: number, sampleRate: number): number {
  return Math.round(byteLength / ((sampleRate / 1000) * 2));
}

/** One raw Muse Voice Transcribe event shape, as logged (no keys, Brief 14 §2). */
export interface RawTranscriptEvent {
  type?: string;
  transcript?: string;
  text?: string;
  partial?: string;
  words?: unknown;
  segments?: unknown;
  [key: string]: unknown;
}

export interface NativeWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function timingFromObject(obj: Record<string, unknown>): NativeWordTiming | null {
  const word = typeof obj.word === "string" ? obj.word : typeof obj.text === "string" ? obj.text : "";
  const start = num(obj.startMs) ?? num(obj.start_ms) ?? (num(obj.start) !== null ? num(obj.start)! * (num(obj.start)! < 10000 ? 1000 : 1) : null);
  const end = num(obj.endMs) ?? num(obj.end_ms) ?? (num(obj.end) !== null ? num(obj.end)! * (num(obj.end)! < 10000 ? 1000 : 1) : null);
  if (start === null) return null;
  return { word, startMs: Math.round(start), endMs: Math.round(end ?? start) };
}

/**
 * Word/segment timings if the realtime event carries them, else null.
 * Live events observed so far carry only transcript text (see test fixture),
 * so callers fall back to partial-based mapping when this returns null.
 */
export function extractWordTimings(raw: RawTranscriptEvent): NativeWordTiming[] | null {
  const candidates: unknown[] = [];
  if (Array.isArray(raw.words)) candidates.push(...raw.words);
  if (Array.isArray(raw.segments)) {
    for (const seg of raw.segments as Array<Record<string, unknown>>) {
      if (Array.isArray(seg.words)) candidates.push(...seg.words);
      else candidates.push(seg);
    }
  }
  if (candidates.length === 0) return null;
  const out: NativeWordTiming[] = [];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const t = timingFromObject(c as Record<string, unknown>);
      if (t) out.push(t);
    }
  }
  return out.length ? out : null;
}
