# Brief 09b: findings from the first synthetic-owner run

The director ran `npm run sim -- --profiles all --turns 4 --concurrency 3 --preset cafe_food --debrief`
against a live server (commit a0cfa50). Every session stopped after turn 1. Good news first: the reporter is
sharp (evasive got "That didn't answer it. Did your chicken sandwich make Maya sick, yes or no?"; contradicts got
interrupted with "What test results? None have been published."). Fix these, in this order.

## 1. Sim: audio_end accounting is wrong (sim bug)

`playTurn` step 4 waits for the reply's `audio_end`; then the next `playTurn` step 1 waits for *another* `audio_end`
that never comes ("timeout waiting for reporter audio_end" in every session). Also step 4 takes its baseline
(`replyEndsBefore`) only after streaming the answer, so a fast reply that finishes during the trailing silence is
missed ("timeout waiting for reporter reply audio_end" in `hesitant`). Model the reporter's lines as a queue of
`{ text, audioBytes, ended }` filled by the message handler; each turn consumes exactly one line (the opening
question or the previous reply/cut-in) and plays it back for its real duration. Unit test the queue logic.

## 2. Sim: behave like a real mic

A browser streams mic frames continuously while listening. The sim goes silent for several seconds while the owner
agent writes and voices its answer, which a real person would fill with silence on the mic. Stream silence frames
at real-time pace whenever the server is listening and the owner is not speaking (including while the owner
answer is being generated). Generate the owner's answer *before* sending `playback_done` where possible.

## 3. Product: keep-alive leaves a growing deficit ("Ingress audio slower than real-time" again)

The server log shows `[stt] session error while listening: Ingress audio slower than real-time; reopening`.
The keep-alive pushes 100 ms of silence only after 300 ms without client frames, so each gap leaves up to 300 ms of
deficit that is never recovered; Muse Voice Transcribe compares cumulative audio received with wall time. Fix:
per STT session track `audioMsSent` against `wallMsSinceOpen`, and every 100 ms top up silence whenever the deficit
exceeds 150 ms (cap a single top-up at 1 s). Count client frames by their byte length. Log top-ups at debug level.
Unit test with a fake clock: irregular client frames plus top-ups keep the deficit under 200 ms; no top-up while
frames arrive on time.

## 4. Product: hesitant owners get cut off

`hesitant` said "well, so the thing is I, let me think." then paused, and the turn ended after 1.5 s; the reporter
answered "You're stalling." People think aloud under pressure; cutting them off at their first pause feels broken.
Make the turn-end silence adaptive, deterministic and testable (`server/src/session/turn-end.ts`):
- default `TURN_END_SILENCE_MS` (1500) when the answer looks complete,
- extend to `TURN_END_HESITANT_MS` (default 3200) when the answer so far is under 8 words, or its last words are a
  filler or an unfinished clause: "so", "and", "but", "because", "or", "um", "uh", "er", "like", "I mean",
  "the thing is", "let me think", "you know", "well", or it ends with a comma,
- the speculative LLM call still starts at the first final (abort if speech continues), so a complete answer is
  not slower.
Unit tests for both paths and for the speculative call.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report. The director will re-run the sim.
