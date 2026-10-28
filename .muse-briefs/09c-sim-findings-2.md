# Brief 09c: findings from the second synthetic-owner run

Second sim run (commit 235a24b, 6 profiles x 4 turns): **24/24 turns completed, 0 errors, 0 failures.** The STT
deficit fix and the sim fixes work. The reporter stays sharp and specific ("Keeping them isn't checking them. Did you
CHECK Tuesday's fridge logs?"). Rambler was interrupted twice (the maximum allowed). The debrief with front page took
33.6 s end to end.

| profile | median latency ms | worst | splits | mean WER |
|---|---|---|---|---|
| contradicts | 4098 | 5008 | 1 | 0.062 |
| evasive | 3079 | 3495 | 0 | 0.007 |
| hesitant | (cut off) | 3581 | 3 of 4 | 0.564 |
| prepared | 3452 | 4202 | 1 | 0.066 |
| rambler | 2708 | 2918 | 2 | 0.318 |
| terse | 3938 | 4578 | 0 | 0.000 |

Two problems remain. Target for the next run: median latency under 2.5 s, and hesitant splits at most 1 of 4.

## 1. Hesitant owners are still cut off mid-answer

Example: "Well, so the thing is, I'm absolutely not saying Emma's wrong. I mean, let me think. I know Emma by sight.
She's a regular. She ate in at about 12.15 on Tuesday" [pause, the owner had more to say] and the reporter jumped in.
The word heuristic only catches trailing fillers; real thinkers pause after full sentences too.

**Semantic end of turn, at no extra latency:** the speculative journalist call already runs during the silence. Add
`"owner_done": true|false` to the journalist-turn JSON: "true if the owner has finished their answer (a complete
answer, a clear refusal or a deliberate deflection); false if they seem to be mid-thought, listing, or about to
continue." Rule in `turn-end.ts`:
- silence >= `TURN_END_SILENCE_MS` (lower the default to 1000) and the speculative result says `owner_done: true`
  → end the turn now;
- the result says `owner_done: false` → keep waiting up to `TURN_END_HESITANT_MS` (3200) of silence; if speech
  resumes, abort and re-run speculatively as now;
- the result has not arrived yet → fall back to the existing word heuristic.
Update `prompts/journalist-turn.md`. Unit tests for all three paths.

## 2. Latency: overlap the voice with the silence window

Today the server waits for the turn to end, then starts TTS (adding about 0.7 to 1.0 s of first-byte time).
**Speculative TTS:** as soon as the speculative LLM result arrives (and `owner_done` is true), start the ElevenLabs
stream into a buffer without sending it. When the turn ends, flush the buffer to the client and keep streaming.
If speech resumes, abort both the LLM and the TTS (shared AbortController) and discard the buffer. Never send audio
generated from a shorter answer than the final one. Timing log gains `speculativeTtsUsed: boolean`. Unit tests with
fake LLM and TTS: buffer flushed on turn end, discarded on resumed speech, no audio sent before the turn ends.

## 3. Show the debrief first, then the front page

The debrief JSON is ready after about 13 s, the front page about 20 s later. Return the debrief as soon as it exists
and fetch the front page separately (`GET /api/sessions/:sessionId/front-page`, which waits for or returns the
image; 202 while still printing). The debrief view shows a "Printing tomorrow's paper." line where the image will
appear. Unit test the endpoint states.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report. The director will re-run the sim.
