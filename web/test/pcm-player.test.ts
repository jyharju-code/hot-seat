import { describe, expect, it } from "vitest";
import { JITTER_BUFFER_MS, Pcm16Aligner, PcmPlayer } from "../src/audio/pcm-player.js";

describe("Pcm16Aligner", () => {
  it("carries an odd trailing byte into the next chunk", () => {
    const a = new Pcm16Aligner();
    expect(a.push(new Uint8Array([1]))).toEqual(new Uint8Array([]));
    expect(a.push(new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2]));
    expect(a.push(new Uint8Array([4, 5, 6]))).toEqual(new Uint8Array([3, 4, 5, 6]));
  });

  it("passes even chunks through unchanged and odd chunks minus the carried byte", () => {
    const a = new Pcm16Aligner();
    expect(a.push(new Uint8Array([1, 2, 3, 4]))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(a.push(new Uint8Array([5, 6, 7]))).toEqual(new Uint8Array([5, 6]));
    // carried 7 joins the next byte
    expect(a.push(new Uint8Array([8]))).toEqual(new Uint8Array([7, 8]));
  });

  it("reset drops a carried byte", () => {
    const a = new Pcm16Aligner();
    a.push(new Uint8Array([9]));
    a.reset();
    expect(a.push(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
  });

  it("output length is always even", () => {
    const a = new Pcm16Aligner();
    for (const chunk of [[1], [2, 3, 4], [5], [6, 7], []]) {
      expect(a.push(new Uint8Array(chunk)).length % 2).toBe(0);
    }
  });
});

interface FakeSource { buffer: unknown; startedAt: number | null; connect: () => void; start: (t: number) => void }
function fakeContext(currentTime: number) {
  const sources: FakeSource[] = [];
  const buffers: Array<{ length: number; data: Float32Array }> = [];
  const ctx = {
    currentTime,
    destination: {},
    createBuffer(_channels: number, length: number, _rate: number) {
      const data = new Float32Array(length);
      buffers.push({ length, data });
      return { duration: length / 24000, getChannelData: () => data };
    },
    createBufferSource() {
      const src: FakeSource = {
        buffer: null,
        startedAt: null,
        connect: () => undefined,
        start(t: number) { src.startedAt = t; },
      };
      sources.push(src);
      return src;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources, buffers };
}

describe("PcmPlayer jitter buffer", () => {
  it("schedules the first chunk of a line ~120 ms ahead, later chunks back-to-back", () => {
    const { ctx, sources } = fakeContext(10);
    const player = new PcmPlayer(ctx);
    player.beginLine();
    player.push(new Uint8Array([0, 0, 0, 0])); // 2 samples = 1/12000 s
    expect(sources).toHaveLength(1);
    expect(sources[0]!.startedAt).toBeCloseTo(10 + JITTER_BUFFER_MS / 1000, 6);
    player.push(new Uint8Array([0, 0]));
    expect(sources[1]!.startedAt).toBeCloseTo(10 + JITTER_BUFFER_MS / 1000 + 2 / 24000, 6);
  });

  it("never builds a buffer from an odd byte count (carries across pushes)", () => {
    const { ctx, sources, buffers } = fakeContext(0);
    const player = new PcmPlayer(ctx);
    player.beginLine();
    player.push(new Uint8Array([1])); // lone byte: nothing scheduled yet
    expect(sources).toHaveLength(0);
    player.push(new Uint8Array([2, 3, 4])); // completes samples 0x0201, 0x0403
    expect(sources).toHaveLength(1);
    expect(buffers[0]!.length).toBe(2);
    expect(buffers[0]!.data[0]).toBeCloseTo(0x0201 / 32768, 6);
    expect(buffers[0]!.data[1]).toBeCloseTo(0x0403 / 32768, 6);
  });

  it("a new line re-arms the jitter delay and drops the carried byte", () => {
    const { ctx, sources } = fakeContext(5);
    const player = new PcmPlayer(ctx);
    player.beginLine();
    player.push(new Uint8Array([7])); // carried, unscheduled
    player.beginLine();
    player.push(new Uint8Array([0, 0]));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.startedAt).toBeCloseTo(5 + JITTER_BUFFER_MS / 1000, 6);
  });

  it("reports time until the scheduled audio ends", () => {
    const { ctx } = fakeContext(2);
    const player = new PcmPlayer(ctx);
    expect(player.millisecondsUntilEnd()).toBe(0);
    player.beginLine();
    player.push(new Uint8Array(new ArrayBuffer(4800))); // 100 ms
    expect(player.millisecondsUntilEnd()).toBeCloseTo(JITTER_BUFFER_MS + 100, 3);
  });
});
