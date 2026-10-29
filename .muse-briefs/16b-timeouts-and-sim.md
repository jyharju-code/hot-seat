# Brief 16b: model-call timeouts, the profile ending, sim latency in browser mode

Verification of brief 16 (browser speech) passed: hot seat sims ran with 0 errors, no ElevenLabs call in browser
mode, debrief 19 s, front page 30 s, news clip 10 s with the soundbite located. Three findings to fix.

## 1. Every model call needs a timeout (most important)

In a 5-minute profile sim the debrief request hung for **50 minutes** and then failed:
`[debrief] generation failed after 3008638ms: fetch failed`, the endpoint returned 502 after 3 008 s. None of
the providers (`meta-llm.ts`, `baseten-llm.ts`, `image-gen.ts`, the transcribe client, the ElevenLabs adapter)
set a timeout, so one hung connection blocks the debrief, the front page and the news clip forever. The earlier
"stuck session" from a human test was probably the same thing.

- Give every outbound model fetch an `AbortSignal.timeout`, combined with any existing session signal. Make
  the values config with sensible defaults: turn LLM 8 s (the race and the 4 s cap stay as they are), scenario
  director 60 s, debrief 90 s, image edit and generation 90 s, news clip anchor TTS (ElevenLabs mode only) 30 s.
- On a timeout or a network error, retry once (the debrief and the front page steps; the turn already has its
  recovery line). Log `[stage] timeout after Nms, retrying` without prompt text.
- The debrief endpoint must answer within about 3 minutes in the worst case with either the debrief or a
  clear 502 the client can retry. The client's existing "Try again" stays.
- Unit tests with a fake fetch that never resolves: each provider aborts at its timeout; the debrief retries
  once and then fails cleanly.

## 2. The profile ending is spoken

At `duration_seconds` the server sends `session_complete` with the thank-you message. In browser mode the
client should speak that message in the reporter's voice (same voice hint as the reporter) and go to the
debrief after it ends, not after a fixed 600 ms. If the owner is mid-answer at that moment, the line is a warm
cut-in ("I'm so sorry to stop you there, we're out of time. Thank you, this was lovely.").

Also check the wrap-up at duration minus 45 s: in a sim with a long-winded owner (answers of 60 to 90 s) the
reporter never got to say the wrap-up line before the session ended. If the owner is speaking at the wrap-up
moment, the next reporter line must be the wrap-up question; if there is no next line before the end, the
final thank-you covers it. A unit test for both orders.

## 3. Sim latency in browser mode

The sim reports `latency n/a` in browser mode because `firstAudioAt` is only set on a binary audio frame. In
browser mode, set it when the `reporter_line` with a voice hint arrives (that is when a real browser starts
speaking, give or take the client-reported `speechStartMs`). The sim also records, per session, whether
`session_complete` arrived and whether a wrap-up line was spoken, and prints both in the report for profile
runs.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
