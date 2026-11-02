/**
 * In-memory session-generation caps (Brief 19). Counts scenario generations
 * so the remaining Meta credits survive a public URL. Unset or 0 means no cap.
 */

export interface CapsConfig {
  maxSessionsPerDay: number;
  maxSessionsPerIpPerHour: number;
}

export type CapsRefusal = "day" | "ip";

export const nowMs = (): number => Date.now();

const HOUR_MS = 60 * 60 * 1000;

export const DAY_CAP_MESSAGE = "The demo has used its sessions for today. Please try again tomorrow.";
export const IP_CAP_MESSAGE = "Too many sessions from this address lately. Please try again in a bit.";

export function capsRefusalMessage(refusal: CapsRefusal): string {
  return refusal === "day" ? DAY_CAP_MESSAGE : IP_CAP_MESSAGE;
}

export class SessionCaps {
  private dayKey = "";
  private dayCount = 0;
  private readonly ipHits = new Map<string, number[]>();

  constructor(private readonly config: CapsConfig) {}

  /**
   * Check the caps and record one generation when allowed. Returns null when
   * allowed, otherwise which cap refused (no model call should follow).
   */
  checkAndRecord(ip: string, now: number = nowMs()): CapsRefusal | null {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.dayCount = 0;
    }
    if (this.config.maxSessionsPerDay > 0 && this.dayCount >= this.config.maxSessionsPerDay) {
      return "day";
    }
    if (this.config.maxSessionsPerIpPerHour > 0) {
      const cutoff = now - HOUR_MS;
      const hits = (this.ipHits.get(ip) ?? []).filter((t) => t > cutoff);
      if (hits.length >= this.config.maxSessionsPerIpPerHour) {
        this.ipHits.set(ip, hits);
        return "ip";
      }
      hits.push(now);
      this.ipHits.set(ip, hits);
      // Drop empty buckets so the map cannot grow without bound.
      if (this.ipHits.size > 10_000) {
        for (const [key, times] of this.ipHits) {
          if (times.every((t) => t <= cutoff)) this.ipHits.delete(key);
        }
      }
    }
    this.dayCount += 1;
    return null;
  }
}
