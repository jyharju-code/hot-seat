import { describe, expect, it } from "vitest";
import { ElevenLabsTextToSpeech, rechunkPcm16 } from "../src/providers/text-to-speech.js";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of source) out.push(c);
  return out;
}
async function* fromChunks(chunks: number[][]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}
const concat = (chunks: Uint8Array[]) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};

describe("rechunkPcm16", () => {
  it("realigns odd-sized input chunks: byte-identical, every chunk even", async () => {
    const input = [[1], [2, 3, 4], [5], [6, 7, 8, 9, 10], [11, 12, 13]];
    const out = await collect(rechunkPcm16(fromChunks(input), 4));
    for (const c of out) expect(c.length % 2).toBe(0);
    // total input is 13 bytes (odd) -> last lone byte dropped
    expect(concat(out)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(concat(out).length).toBe(12);
  });

  it("preserves even total length exactly, slicing to the target chunk size", async () => {
    const bytes = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = await collect(rechunkPcm16(fromChunks([bytes.slice(0, 3), bytes.slice(3, 8), bytes.slice(8)]), 6));
    for (const c of out) { expect(c.length % 2).toBe(0); expect(c.length).toBeLessThanOrEqual(6); }
    expect(concat(out)).toEqual(new Uint8Array(bytes));
  });

  it("drops a final lone byte and emits nothing for a single-byte stream", async () => {
    expect(await collect(rechunkPcm16(fromChunks([[7]]), 4800))).toEqual([]);
    const out = await collect(rechunkPcm16(fromChunks([[1, 2, 3]]), 4800));
    expect(concat(out)).toEqual(new Uint8Array([1, 2]));
  });

  it("skips empty chunks", async () => {
    const out = await collect(rechunkPcm16(fromChunks([[], [1, 2], [], [3, 4]]), 4800));
    expect(concat(out)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("default chunk size stays within 960..4800 bytes except a short tail", async () => {
    const bytes = Array.from({ length: 10000 }, (_, i) => i % 256);
    const out = await collect(rechunkPcm16(fromChunks([bytes.slice(0, 1201), bytes.slice(1201, 5000), bytes.slice(5000)])));
    for (const c of out) { expect(c.length % 2).toBe(0); expect(c.length).toBeLessThanOrEqual(4800); }
    for (const c of out.slice(0, -1)) expect(c.length).toBeGreaterThanOrEqual(960);
    expect(concat(out)).toEqual(new Uint8Array(bytes));
  });
});

describe("ElevenLabsTextToSpeech cancellation (brief 08 item 4)", () => {
  it("passes the AbortSignal to fetch and cancels the reader when the consumer stops early", async () => {
    let seenSignal: AbortSignal | undefined;
    let readerCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4800)); },
      cancel() { readerCancelled = true; },
    });
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const tts = new ElevenLabsTextToSpeech({ apiKey: "test", defaultVoiceId: "v1", fetchFn });
    const controller = new AbortController();
    const iter = tts.synthesize("hello", { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    if (iter.return) await iter.return(undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Brief 16b: fetch gets the session signal combined with the timeout.
    expect(seenSignal).toBeTruthy();
    expect(seenSignal).not.toBe(controller.signal);
    controller.abort();
    expect(seenSignal!.aborted).toBe(true);
    expect(readerCancelled).toBe(true);
  });
});

describe("ElevenLabsTextToSpeech rechunking", () => {
  it("yields only even-length chunks from an odd-chunked upstream stream", async () => {
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6, 7, 8, 9])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const p of parts) controller.enqueue(p); controller.close(); },
    });
    const fetchFn = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const tts = new ElevenLabsTextToSpeech({ apiKey: "test", defaultVoiceId: "v1", fetchFn });
    const out = await collect(tts.synthesize("hello"));
    for (const c of out) expect(c.length % 2).toBe(0);
    // 9 input bytes -> 8 output bytes, byte-identical prefix
    expect(concat(out)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  });
});
