import { describe, expect, it } from "vitest";
import { SpeculativeTtsBuffer } from "../src/session/speculative-tts.js";
import type { TextToSpeech } from "../src/providers/text-to-speech.js";

class FakeTts implements TextToSpeech {
  texts: string[] = [];
  aborted = false;
  async *synthesize(text: string, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
    this.texts.push(text);
    if (options?.signal) {
      options.signal.addEventListener("abort", () => { this.aborted = true; }, { once: true });
    }
    yield new Uint8Array([1, 0]);
    yield new Uint8Array([2, 0]);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SpeculativeTtsBuffer (fake TTS)", () => {
  it("buffers without sending, then flushes on drain (turn end)", async () => {
    const tts = new FakeTts();
    const sent: Uint8Array[] = [];
    const buffer = SpeculativeTtsBuffer.start(tts, "Hello there.");
    await tick();
    await tick();
    expect(tts.texts).toEqual(["Hello there."]);
    expect(buffer.bufferedChunks.length).toBe(2);
    expect(sent).toHaveLength(0);
    await buffer.drain((c) => sent.push(c));
    expect(sent.map((c) => [...c])).toEqual([[1, 0], [2, 0]]);
  });

  it("discarded buffer sends nothing on drain", async () => {
    const tts = new FakeTts();
    const buffer = SpeculativeTtsBuffer.start(tts, "Shorter reply.");
    await tick();
    await tick();
    buffer.discard();
    const sent: Uint8Array[] = [];
    await buffer.drain((c) => sent.push(c));
    expect(sent).toHaveLength(0);
    expect(buffer.isDiscarded).toBe(true);
  });

  it("shared abort stops the underlying TTS stream", async () => {
    const tts = new FakeTts();
    const controller = new AbortController();
    const buffer = SpeculativeTtsBuffer.start(tts, "Hello.", { signal: controller.signal, voiceId: "v1" });
    await tick();
    controller.abort();
    expect(tts.aborted).toBe(true);
    await buffer.finished;
  });
});
