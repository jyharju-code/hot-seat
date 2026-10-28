/** Real-time pacing schedule for owner speech. Pure, unit tested. */

/** One mic frame: 100 ms of PCM16 at 16 kHz. */
export const FRAME_MS = 100;
export const FRAME_BYTES = 3200;
/** Bytes per millisecond of PCM16 at 16 kHz. */
export const BYTES_PER_MS = 32;

export interface SegmentTiming {
  durationMs: number;
  pauseAfterMs: number;
}

export interface FramePlanItem {
  /** Absolute offset from speech start when this frame is due. */
  atMs: number;
  segmentIndex: number;
  /** Silence frames carry a segment's pause_after_ms, not speech. */
  silence: boolean;
}

/** Audio frames per segment, each followed by its pause as silence frames. */
export function buildFramePlan(segments: readonly SegmentTiming[], frameMs = FRAME_MS): FramePlanItem[] {
  const plan: FramePlanItem[] = [];
  let atMs = 0;
  segments.forEach((segment, segmentIndex) => {
    const audioFrames = Math.max(0, Math.ceil(segment.durationMs / frameMs));
    for (let i = 0; i < audioFrames; i++) {
      plan.push({ atMs, segmentIndex, silence: false });
      atMs += frameMs;
    }
    const silenceFrames = Math.max(0, Math.round(segment.pauseAfterMs / frameMs));
    for (let i = 0; i < silenceFrames; i++) {
      plan.push({ atMs, segmentIndex, silence: true });
      atMs += frameMs;
    }
  });
  return plan;
}

/** A person stops speaking at once when interrupted: keep only frames due before it. */
export function takeUntilInterrupt(plan: readonly FramePlanItem[], interruptAtMs: number | null): FramePlanItem[] {
  if (interruptAtMs === null) return [...plan];
  return plan.filter((item) => item.atMs < interruptAtMs);
}

export function shouldStopSpeaking(interrupted: boolean): boolean {
  return interrupted;
}

/** Duration of a PCM buffer at 16 kHz PCM16. */
export function pcmDurationMs(bytes: number): number {
  return bytes / BYTES_PER_MS;
}

/** Silence bytes to insert for a pause at 16 kHz PCM16. */
export function silenceBytes(pauseMs: number): number {
  return Math.max(0, Math.round(pauseMs * BYTES_PER_MS));
}
