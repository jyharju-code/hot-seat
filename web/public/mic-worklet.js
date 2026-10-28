/* global AudioWorkletProcessor, sampleRate, registerProcessor */
import { createResampler } from "./mic-resample.js";

// Downsamples mic input to 16 kHz PCM16 mono and posts ArrayBuffers.
class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = createResampler(sampleRate, 16000);
    this.buf = [];
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const down = this.resampler.push(ch);
    for (let i = 0; i < down.length; i++) {
      const s = Math.max(-1, Math.min(1, down[i]));
      this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      if (this.buf.length >= 1600) { // ~100 ms
        const out = new Int16Array(this.buf);
        this.buf = [];
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("mic-downsampler", MicDownsampler);
