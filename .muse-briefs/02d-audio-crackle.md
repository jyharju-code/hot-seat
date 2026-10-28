# Brief 02d: reporter audio crackles

Human test result: the loop works and the reporter is sharp, but the reporter's voice **crackles badly**.

Root cause, measured by the director over `/ws`: ElevenLabs streams PCM16 in chunks of arbitrary byte length.
In one reporter line 76 of 328 binary chunks had an odd length (e.g. 1201, 477, 515 bytes). We forward them
unchanged, so 16-bit samples are split across chunks: the browser's `new Int16Array(chunk)` either throws or
everything after the split is byte-shifted, which is heard as loud crackle.

Fix it at the source and defend at the edge:

1. **Server, TTS adapter:** re-chunk the stream so every yielded chunk has an even byte length. Carry an odd
   trailing byte over to the next chunk; at the end of the stream drop a final lone byte. Prefer chunks of
   whole samples around 20 to 100 ms (960 to 4800 bytes at 24 kHz) so the client schedules fewer, larger
   buffers. Unit test with odd-sized input chunks: output is byte-identical to the input concatenation (minus
   at most one trailing byte) and every chunk length is even.
2. **Web, playback:** never construct `Int16Array` from an odd-length buffer (carry a byte as on the server).
   Add a small jitter buffer: when a new reporter line starts, schedule the first chunk about 120 ms ahead of
   `currentTime` so later chunks do not underrun and leave gaps. Keep the logic in a small module
   (`web/src/audio/pcm-player.ts`) with a unit-testable byte-alignment part.
3. Do not change anything else in this brief.

Same rules as before. `npm run check`, `npm run smoke:voice`, small commits, push to `origin main`, short report.
