// Fractional resampling to 16 kHz with linear interpolation.
// Plain JS so the AudioWorklet and unit tests share the exact same code.

export function createResampler(inputRate, outputRate = 16000) {
  const step = inputRate / outputRate;
  let buffer = [];
  let pos = 0; // fractional read position in `buffer`
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) buffer.push(chunk[i]);
      const out = [];
      while (pos < buffer.length) {
        const i = Math.floor(pos);
        const frac = pos - i;
        if (frac === 0) {
          out.push(buffer[i]);
        } else if (i + 1 < buffer.length) {
          out.push(buffer[i] * (1 - frac) + buffer[i + 1] * frac);
        } else {
          break; // need the next input sample to interpolate
        }
        pos += step;
      }
      const drop = Math.min(Math.floor(pos), buffer.length);
      if (drop > 0) {
        buffer = buffer.slice(drop);
        pos -= drop;
      }
      return new Float32Array(out);
    },
  };
}

export function resampleBuffer(input, inputRate, outputRate = 16000) {
  const resampler = createResampler(inputRate, outputRate);
  const main = resampler.push(input);
  // Flush: one trailing sample can be emitted without interpolation past it
  // only when it lands exactly; otherwise the streamed length is correct.
  return main;
}
