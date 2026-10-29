# Brief 18: browser speech stall, and answers cut short

Narrow brief, two bugs found with `DEV_TURN_LOG=1` in a real profile test by the user (session `ca4fd41a`).
Touch only the files named here unless a test needs more.

## 1. The session froze at 2:20: the browser never spoke the line

Turn 6: the server sent the reporter line at 881.1 s ("The vision pulled you through? Tell me more, when was
it hardest and what did it cost you?"). **No `speech_started` ever arrived** (every earlier turn had one within
2 ... 4 ms). The user heard silence, saw nothing happen and ended the session after about 8 s. The per-sentence
timeout in `web/src/audio/browser-speech.ts` only rescues `onend`; with two sentences it waits about 11 s of
dead silence before `playback_done`. Chrome's `speechSynthesis` is known to stall (paused queue, a stale
utterance, the long-session bug).

Fix in `web/src/audio/browser-speech.ts` (and the caller in `web/src/Session.tsx` only if needed):

- Before each `speak()`: if `synth.paused`, call `resume()`; if `synth.speaking || synth.pending` while our
  queue is idle, `cancel()` first.
- **Start watchdog**: if `onstart` has not fired within 1500 ms, `cancel()` and speak the same sentence again
  once. If it still does not start within 1500 ms, give up on audio for this line: keep the line visible as
  text (it already is), wait a short reading time (about 2.6 words per second, at most 6 s), then send
  `playback_done` so the interview continues.
- Tell the server: a new client message `speech_failed` `{ reason: "no_start" | "error" }` (zod in `shared`),
  logged by the server and written to the dev turn log. No UI error; at most a quiet "Voice hiccup, the
  question is on screen." line for that turn.
- Keepalive for long lines: while speaking, `pause(); resume();` every 10 s (the usual Chrome workaround).
- Unit tests with a fake `speechSynthesis` that never fires `onstart`, and one that fires it only on retry.

## 2. Answers cut short: `owner_done` ends a two-word answer after 1 s

From the dev turn log, the turn ended with `turnEndReason: owner_done` on:

- turn 1: committed "my dream?" (one partial, 0.2 s of speech),
- turn 6: committed "was the vision" (0.9 s of speech).

The user is a non-native English speaker who pauses to find words. In `server/src/session/turn-end.ts`,
`owner_done: true` from the model returns the 1000 ms window and overrides the "under 8 words looks
unfinished" heuristic, so a pause after the first words ends the turn and the rest of the answer is lost
(the mic closes while the reporter speaks).

Fix:

- The model's `owner_done: true` may shorten the wait only when the answer has **at least 8 words**. Under 8
  words, always use the hesitant window (3200 ms) unless it is a clear one-word reply to a yes/no question
  ("yes", "no", "sure", "correct", and similar).
- Raise the normal window from 1000 ms to 1400 ms (config `TURN_END_SILENCE_MS` default). Keep the 4000 ms cap.
- **Late continuation**: if the owner starts speaking again after the turn has ended but **before** the
  reporter's line has started playing (the model call takes about 1.5 ... 2 s), abort that reply, keep
  listening, and treat it as one answer (join the texts). Only before `speech_started`; never cut the reporter
  off mid-line.
- Unit tests for the new rules in `turn-end.ts`, and an orchestrator test for the late continuation.
- Sim: the `hesitant` and `rambler` profiles must not get worse splits than before (report the split counts).

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
