import { describe, expect, it } from "vitest";
// Pure resampler shared with web/public/mic-worklet.js (plain JS module).
// @ts-expect-error plain JS module without types
import { createResampler, resampleBuffer } from "../public/mic-resample.js";

describe("mic resampling to 16 kHz (brief 08 item 6)", () => {
  it("44.1 kHz: a ramp resamples by linear interpolation at the fractional step", () => {
    const input = new Float32Array(441);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = resampleBuffer(input, 44100) as Float32Array;
    // 441 samples at 44.1k = 10 ms = 160 samples at 16k.
    expect(out.length).toBe(160);
    const step = 44100 / 16000;
    for (const k of [0, 1, 2, 10, 100, 159]) {
      expect(out[k]).toBeCloseTo(k * step, 3);
    }
  });

  it("44.1 kHz: output rate is really 16 kHz for a steady tone (not 14.7 kHz)", () => {
    // One second of a 440 Hz sine at 44.1 kHz.
    const input = new Float32Array(44100);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 44100);
    const out = resampleBuffer(input, 44100) as Float32Array;
    expect(out.length).toBeGreaterThanOrEqual(15999);
    expect(out.length).toBeLessThanOrEqual(16001);
    // Count zero crossings: ~880 per second for 440 Hz.
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1]! < 0) !== (out[i]! < 0)) crossings += 1;
    expect(crossings).toBeGreaterThan(860);
    expect(crossings).toBeLessThan(900);
  });

  it("48 kHz: exact 3:1 step, output picks every third interpolated point", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = resampleBuffer(input, 48000) as Float32Array;
    expect(out.length).toBe(160);
    for (const k of [0, 1, 5, 159]) expect(out[k]).toBeCloseTo(3 * k, 5);
  });

  it("streaming chunks keep fractional position across calls", () => {
    const r = createResampler(44100) as { push: (c: Float32Array) => Float32Array };
    const chunk = new Float32Array(128);
    let total = 0;
    let last: Float32Array | null = null;
    for (let n = 0; n < 10; n++) {
      for (let i = 0; i < chunk.length; i++) chunk[i] = n * 128 + i;
      last = r.push(chunk);
      total += last.length;
    }
    // 1280 samples at 44.1k -> floor-ish 1280 / 2.75625 = 464.4 samples.
    expect(total).toBeGreaterThanOrEqual(463);
    expect(total).toBeLessThanOrEqual(465);
    expect(last!.length).toBeGreaterThan(0);
  });
});
