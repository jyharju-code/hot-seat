# Brief 02c: turn-taking fixes from the first live test

The director drove the server over `/ws` with a recorded 13-second spoken answer (a real person, natural pauses).
The loop works end to end and the reporter correctly called out a dodge. Fix these before the human test:

1. **The owner gets cut off after the first sentence.** The answer was 13 s long but the turn ended after
   "We take this extremely seriously." Muse Voice Transcribe in ENDPOINTING mode emits `speechComplete` at short
   pauses; we treat the first one as the end of the turn and drop the rest. People pause while answering hard
   questions, so the turn must survive them:
   - Keep collecting while listening: concatenate consecutive final segments into one answer.
   - End the turn only after `TURN_END_SILENCE_MS` (default 1500, configurable via env) with no new final and
     no new partial text since the last final.
   - Keep the STT session open across those pauses; open a fresh one only for the next turn.
   - Unit tests with a fake STT: two finals 600 ms apart become one turn; a 1500 ms gap ends the turn.
2. **Empty transcripts trigger a reporter turn.** An empty final (`""`) made the reporter speak again.
   Ignore empty or whitespace-only finals; never call the LLM for an empty answer. Test it.
3. **Timing reference is missing.** `speechEndToFinalMs` is always 0, so no `speechEnd` event reaches the
   orchestrator. Log the raw `type` of every distinct STT event once (debug) to find the real event names, and
   measure from the end of the owner's speech: use the endpoint event if it exists, otherwise the arrival time of
   the last final segment of the turn. Report from what point the numbers are now measured.
4. **Audio tags show up in the UI.** Lines like "[sharply] Did you know..." are displayed with the tags. Keep the
   tags for TTS, strip `[...]` tags from everything displayed (headline and transcript), in one shared helper
   in `shared/` with a test.
5. Commit the brief files in `.muse-briefs/` (02, 02b, 02c); they document how the project was directed.

Rules as before: no listening ports in your sandbox, never print keys, no elevated retries. Run
`npm run check` and `npm run smoke:voice`, commit in small logical commits, push to `origin main`, and finish
with a short report.
