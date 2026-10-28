export const PCM_SAMPLE_RATE = 24000;
export const JITTER_BUFFER_MS = 120;

/** Carries an odd trailing byte into the next chunk so output is always sample-aligned. */
export class Pcm16Aligner {
  private pending: number | null = null;

  push(chunk: Uint8Array): Uint8Array {
    let bytes = chunk;
    if (this.pending !== null) {
      const merged = new Uint8Array(chunk.length + 1);
      merged[0] = this.pending;
      merged.set(chunk, 1);
      bytes = merged;
    }
    const evenLength = bytes.length - (bytes.length % 2);
    this.pending = evenLength < bytes.length ? (bytes[bytes.length - 1] ?? null) : null;
    return bytes.slice(0, evenLength);
  }

  reset(): void {
    this.pending = null;
  }
}

/** Schedules aligned PCM16 chunks on an AudioContext, with a jitter buffer per line. */
export class PcmPlayer {
  private readonly ctx: AudioContext;
  private readonly aligner = new Pcm16Aligner();
  private nextTime = 0;
  private lineStarted = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Mark the start of a new reporter line. The jitter delay is armed here and
   *  applied when the first chunk actually arrives, so TTS latency does not eat it. */
  beginLine(): void {
    this.aligner.reset();
    this.nextTime = 0;
    this.lineStarted = true;
  }

  push(data: ArrayBuffer | Uint8Array): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const aligned = this.aligner.push(bytes);
    if (aligned.length === 0) return;
    const pcm = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
    const buf = this.ctx.createBuffer(1, pcm.length, PCM_SAMPLE_RATE);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    if (!this.lineStarted || this.nextTime === 0) {
      this.nextTime = this.ctx.currentTime + JITTER_BUFFER_MS / 1000;
      this.lineStarted = true;
    }
    const start = Math.max(this.nextTime, this.ctx.currentTime);
    src.start(start);
    this.nextTime = start + buf.duration;
  }

  millisecondsUntilEnd(): number {
    if (this.nextTime === 0) return 0;
    return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
  }

  reset(): void {
    this.aligner.reset();
    this.nextTime = 0;
    this.lineStarted = false;
  }
}
