/* global AudioWorkletProcessor, sampleRate, registerProcessor */
// Downsamples mic input to 16 kHz PCM16 mono and posts ArrayBuffers.
class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.count = 0;
    this.buf = [];
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.count++;
      if (this.count >= this.ratio) {
        const avg = this.acc / this.count;
        this.acc = 0; this.count = 0;
        const s = Math.max(-1, Math.min(1, avg));
        this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        if (this.buf.length >= 1600) { // ~100 ms
          const out = new Int16Array(this.buf);
          this.buf = [];
          this.port.postMessage(out.buffer, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-downsampler", MicDownsampler);
