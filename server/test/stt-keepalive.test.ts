import { describe, expect, it } from "vitest";
import {
  SttKeepAliveTracker,
  silenceBytesForMs,
  topUpMsForDeficit,
} from "../src/session/stt-keepalive.js";

describe("STT keep-alive deficit tracker (fake clock)", () => {
  it("irregular client frames plus top-ups keep the deficit under 200 ms", () => {
    const tracker = new SttKeepAliveTracker(0);
    // Irregular client frames: bursts, then long owner-thinking gaps.
    const framesAt = new Map<number, number>([
      [0, 3200], // 100 ms on time
      [100, 3200],
      [700, 6400], // 200 ms after a 400 ms gap
      [2500, 3200],
      [2600, 3200],
      [9000, 3200],
    ]);
    let maxDeficitAfterTick = 0;
    for (let now = 0; now <= 10_000; now += 100) {
      const bytes = framesAt.get(now);
      if (bytes) tracker.noteFrame(bytes);
      const topUp = tracker.topUp(now);
      if (topUp > 0) expect(topUp).toBeLessThanOrEqual(1000);
      maxDeficitAfterTick = Math.max(maxDeficitAfterTick, tracker.deficitMs(now));
    }
    expect(maxDeficitAfterTick).toBeLessThan(200);
    // Audio sent tracks wall time (within one tick + threshold).
    expect(tracker.audioMsSent).toBeGreaterThan(9800);
  });

  it("no top-up while frames arrive on time", () => {
    const tracker = new SttKeepAliveTracker(1000);
    for (let now = 1000; now <= 6000; now += 100) {
      tracker.noteFrame(3200); // exactly 100 ms of audio every 100 ms
      expect(tracker.topUp(now)).toBe(0);
    }
    expect(tracker.deficitMs(6000)).toBeLessThanOrEqual(0);
  });

  it("caps a single top-up at 1 s and recovers over later ticks", () => {
    const tracker = new SttKeepAliveTracker(0);
    expect(tracker.topUp(10_000)).toBe(1000);
    expect(tracker.deficitMs(10_000)).toBe(9000);
    expect(topUpMsForDeficit(150)).toBe(0);
    expect(topUpMsForDeficit(151)).toBe(151);
    expect(topUpMsForDeficit(5000)).toBe(1000);
    expect(silenceBytesForMs(100)).toBe(3200);
    expect(silenceBytesForMs(1000)).toBe(32000);
  });

  it("counts client frames by byte length and resets per session", () => {
    const tracker = new SttKeepAliveTracker(0);
    tracker.noteFrame(1600); // 50 ms
    tracker.noteFrame(4800); // 150 ms
    expect(tracker.audioMsSent).toBe(200);
    expect(tracker.deficitMs(500)).toBe(300);
    tracker.reset(500);
    expect(tracker.audioMsSent).toBe(0);
    expect(tracker.deficitMs(500)).toBe(0);
  });
});
