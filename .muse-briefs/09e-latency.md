# Brief 09e: latency, the last big step

Fourth run (commit 264f7c0, preset `review_storm`): 24/24 turns, 0 errors. Splits improved (hesitant 2, prepared 1,
evasive 1, terse 0). Debrief 14.5 s, then front page 18.1 s later: good. Speculative TTS was used in 13 of 20 turns.

But the latency a human feels is still about 3.2 s median for normal answers (prepared 3346, evasive 3215,
terse 3589 ms), and the target is about 2 s. Measurements from the server log:

- The hedge fired in 14 of 25 turns and **Meta won every time** (Meta total 1851 to 2784 ms). Baseten started 1.8 s
  late, so it could never win. The hedge as built does nothing.
- The speculative LLM call starts only when Muse Voice Transcribe sends the **final** (`speechComplete`), which comes
  roughly a second after the owner stops speaking. Feel ≈ endpoint delay (~1 s) + LLM (~2 s).

## 1. Start the speculative turn on a stable partial

`transcript` partial events arrive continuously (cumulative text). When the partial text has not changed for
`PARTIAL_STABLE_MS` (default 450 ms) and has at least 3 words, start the speculative journalist call with that text.
When the final arrives, compare normalised text (lowercase, no punctuation, collapse spaces): if it equals the text
the in-flight call was started with (or differs only in punctuation and casing), keep the call; otherwise abort and
restart with the final. If new partial words arrive, abort as today. Unit tests: stable partial starts the call,
equal final keeps it, different final restarts it, new words abort.

## 2. Race both providers for turn calls instead of hedging late

When both keys are configured and `TURN_RACE=on` (default on), send each journalist turn call to Meta and Baseten
**at the same time**, take the first valid JSON, abort the other. Keep the hedge code path for `TURN_RACE=off`.
Log `race: winner=<meta|baseten> ms=<n> loser_ms=<n|aborted>`. Interrupt decisions race too. Scenario, debrief and
images stay on Meta only. Unit tests with fake providers.

## 3. Measure what we changed

Timing log per turn gains `partialStartUsed: boolean` and `raceWinner`. Add a line to `docs/measurements.md`
describing the race and the stable-partial start (the director will fill in the numbers from the next sim run).

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
