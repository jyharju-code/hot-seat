import {
  buildWordTimes,
  PCM16_16K_BYTES_PER_MS,
  type PartialObservation,
  type WordTime,
} from "../news/soundbite.js";

/** One sealed owner turn with its word times on the owner-audio stream. */
export interface OwnerTurnTiming {
  text: string;
  wordTimes: WordTime[];
  /** Owner-audio stream ms at turn start / end. */
  startStreamMs: number;
  endStreamMs: number;
  /** Native STT word timings used instead of the partial map, when present. */
  nativeWordTimes: WordTime[] | null;
}

interface OffsetMark {
  byteOffset: number;
  wallMs: number;
}

/**
 * Per-session owner mic audio (PCM16 16 kHz), in memory only.
 * Maps stream byte offset to wall time. Never written to disk.
 */
export class OwnerAudioBuffer {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private marks: OffsetMark[] = [];
  private observations: PartialObservation[] = [];
  private turnStartByte = 0;
  readonly turns: OwnerTurnTiming[] = [];
  /** Retained soundbite after trimming, as stream ms of the original stream. */
  retainedSegment: { startMs: number; endMs: number } | null = null;

  constructor(private readonly asrLagMs: number = 350) {}

  get byteLength(): number {
    return this.totalBytes;
  }

  get durationMs(): number {
    return Math.round(this.totalBytes / PCM16_16K_BYTES_PER_MS);
  }

  push(pcm: Uint8Array, wallMs: number): void {
    if (!pcm.length) return;
    this.marks.push({ byteOffset: this.totalBytes, wallMs });
    this.chunks.push(pcm.slice());
    this.totalBytes += pcm.length;
  }

  /** Wall time for a stream byte offset, interpolated between marks. */
  wallMsForByteOffset(byteOffset: number): number {
    if (this.marks.length === 0) return 0;
    let mark = this.marks[0]!;
    for (const m of this.marks) {
      if (m.byteOffset <= byteOffset) mark = m;
      else break;
    }
    return mark.wallMs + (byteOffset - mark.byteOffset) / PCM16_16K_BYTES_PER_MS;
  }

  streamMsForWallMs(wallMs: number): number {
    if (this.marks.length === 0) return 0;
    let mark = this.marks[0]!;
    for (const m of this.marks) {
      if (m.wallMs <= wallMs) mark = m;
      else break;
    }
    return Math.round(mark.byteOffset / PCM16_16K_BYTES_PER_MS + (wallMs - mark.wallMs));
  }

  notePartial(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.observations.push({ text: trimmed, audioOffsetMs: this.durationMs });
  }

  /** Seal the current turn. Native timings (ms from turn start) win when supplied. */
  sealTurn(text: string, nativeWordTimes?: WordTime[] | null): OwnerTurnTiming {
    const startStreamMs = Math.round(this.turnStartByte / PCM16_16K_BYTES_PER_MS);
    const absoluteNative = nativeWordTimes?.length
      ? nativeWordTimes.map((w) => ({ ...w, startMs: startStreamMs + w.startMs }))
      : null;
    const turn: OwnerTurnTiming = {
      text: text.trim(),
      wordTimes: buildWordTimes(this.observations, this.asrLagMs),
      startStreamMs,
      endStreamMs: this.durationMs,
      nativeWordTimes: absoluteNative,
    };
    if (absoluteNative) turn.wordTimes = absoluteNative;
    this.turns.push(turn);
    this.observations = [];
    this.turnStartByte = this.totalBytes;
    return turn;
  }

  /** Discard a partial-only turn start (no speech sealed). */
  resetTurnObservations(): void {
    this.observations = [];
    this.turnStartByte = this.totalBytes;
  }

  pcm(): Uint8Array {
    const out = new Uint8Array(this.totalBytes);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** Keep only the given original-stream segment; drop everything else. */
  trimToSegment(startMs: number, endMs: number): void {
    const all = this.pcm();
    const start = Math.max(0, Math.floor((startMs * PCM16_16K_BYTES_PER_MS) / 2) * 2);
    const end = Math.max(start, Math.min(all.length, Math.floor((endMs * PCM16_16K_BYTES_PER_MS) / 2) * 2));
    const segment = all.slice(start, end);
    this.chunks = [segment];
    this.totalBytes = segment.length;
    this.marks = [{ byteOffset: 0, wallMs: this.wallMsForByteOffset(start) }];
    this.retainedSegment = { startMs, endMs };
    this.observations = [];
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.marks = [];
    this.observations = [];
    this.turnStartByte = 0;
  }
}

/** In-memory registry keyed by session id. Entries die with the process. */
export const ownerAudioRegistry = new Map<string, OwnerAudioBuffer>();

export function getOrCreateOwnerAudio(sessionId: string, asrLagMs = 350): OwnerAudioBuffer {
  let buf = ownerAudioRegistry.get(sessionId);
  if (!buf) {
    buf = new OwnerAudioBuffer(asrLagMs);
    ownerAudioRegistry.set(sessionId, buf);
  }
  return buf;
}

export function dropOwnerAudio(sessionId: string): void {
  ownerAudioRegistry.delete(sessionId);
}
