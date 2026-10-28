/** Keep-alive accounting for one STT session. Muse Voice Transcribe
 *  compares cumulative audio received with wall time since the session
 *  opened, so silence must top up the deficit, not just follow idle gaps. */

/** PCM16 at 16 kHz: 2 bytes per sample, 16000 samples per second. */
export const STT_BYTES_PER_MS = 32;
export const KEEPALIVE_INTERVAL_MS = 100;
export const KEEPALIVE_DEFICIT_MS = 150;
export const KEEPALIVE_MAX_TOPUP_MS = 1000;

/** Silence needed at `deficitMs`, capped per top-up. Zero when within tolerance. */
export function topUpMsForDeficit(
  deficitMs: number,
  thresholdMs = KEEPALIVE_DEFICIT_MS,
  maxTopUpMs = KEEPALIVE_MAX_TOPUP_MS,
): number {
  if (deficitMs <= thresholdMs) return 0;
  return Math.min(Math.floor(deficitMs), maxTopUpMs);
}

export function silenceBytesForMs(ms: number): number {
  return Math.max(0, Math.round(ms * STT_BYTES_PER_MS));
}

export class SttKeepAliveTracker {
  private openedAtMs: number;
  private audioMs = 0;

  constructor(
    openedAtMs: number,
    private readonly thresholdMs = KEEPALIVE_DEFICIT_MS,
    private readonly maxTopUpMs = KEEPALIVE_MAX_TOPUP_MS,
  ) {
    this.openedAtMs = openedAtMs;
  }

  reset(nowMs: number): void {
    this.openedAtMs = nowMs;
    this.audioMs = 0;
  }

  /** Count a client frame by its byte length. */
  noteFrame(byteLength: number): void {
    if (byteLength > 0) this.audioMs += byteLength / STT_BYTES_PER_MS;
  }

  noteSentMs(ms: number): void {
    if (ms > 0) this.audioMs += ms;
  }

  get audioMsSent(): number {
    return this.audioMs;
  }

  wallMsSinceOpen(nowMs: number): number {
    return Math.max(0, nowMs - this.openedAtMs);
  }

  deficitMs(nowMs: number): number {
    return this.wallMsSinceOpen(nowMs) - this.audioMs;
  }

  /** Top up silence if the deficit exceeds the threshold. Returns the
   *  silence duration to send (already counted as sent), or 0. */
  topUp(nowMs: number): number {
    const ms = topUpMsForDeficit(this.deficitMs(nowMs), this.thresholdMs, this.maxTopUpMs);
    if (ms > 0) this.audioMs += ms;
    return ms;
  }
}
