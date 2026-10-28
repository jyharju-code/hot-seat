import type { TextToSpeech, TextToSpeechOptions } from "../providers/text-to-speech.js";

/** TTS stream consumed into a buffer before the turn ends. Nothing is sent
 *  until `drain` is called; discarding drops the buffer without sending. */
export class SpeculativeTtsBuffer {
  readonly text: string;
  private chunks: Uint8Array[] = [];
  private waiters: Array<() => void> = [];
  private doneFlag = false;
  private errorValue: unknown = null;
  private discarded = false;
  readonly finished: Promise<void>;

  constructor(text: string, source: AsyncIterable<Uint8Array>) {
    this.text = text;
    this.finished = (async () => {
      try {
        for await (const chunk of source) {
          if (chunk.length) this.chunks.push(chunk);
          this.notify();
        }
      } catch (err) {
        this.errorValue = err;
      } finally {
        this.doneFlag = true;
        this.notify();
      }
    })();
    this.finished.catch(() => undefined);
  }

  static start(tts: TextToSpeech, text: string, options?: TextToSpeechOptions): SpeculativeTtsBuffer {
    return new SpeculativeTtsBuffer(text, tts.synthesize(text, options));
  }

  get bufferedChunks(): readonly Uint8Array[] {
    return this.chunks;
  }
  get done(): boolean {
    return this.doneFlag;
  }
  get error(): unknown {
    return this.errorValue;
  }
  get isDiscarded(): boolean {
    return this.discarded;
  }
  get hasAudio(): boolean {
    return this.chunks.length > 0;
  }

  discard(): void {
    this.discarded = true;
    this.chunks = [];
    this.notify();
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private waitChange(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  /** Send buffered chunks, then keep streaming live chunks until done. */
  async drain(send: (chunk: Uint8Array) => void, isStopped: () => boolean = () => false): Promise<void> {
    let sent = 0;
    for (;;) {
      while (sent < this.chunks.length) {
        if (this.discarded) return;
        if (isStopped()) return;
        send(this.chunks[sent]!);
        sent += 1;
      }
      if (this.errorValue) throw this.errorValue;
      if (this.doneFlag || this.discarded) return;
      await this.waitChange();
    }
  }
}
