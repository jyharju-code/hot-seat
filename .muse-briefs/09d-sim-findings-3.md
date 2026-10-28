# Brief 09d: findings from the third synthetic-owner run

Third run (commit 507ae36, preset `contractor_delay`): 24/24 turns, 0 errors, but **splits got worse**
(hesitant 4/4, rambler 4/4, evasive 2, contradicts 2) and latency did not improve (medians 2.3 to 3.9 s; outliers of
9.7 s and 18.5 s where the LLM was slow). Speculative TTS was used in only 3 turns. Example of a bad cut: the rambler
said "Yeah, yeah," then paused for a second, and that became the whole answer.

## Diagnosis

The turn LLM takes 1.5 to 3 s, longer than the new 1000 ms silence window. So at 1000 ms the result is almost never
back, the word-heuristic fallback decides, and it ends the turn at 1000 ms. The semantic `owner_done` rarely gets a
say, and speculative TTS rarely has time to start.

Key insight: the reporter cannot speak before the LLM result exists anyway. So **waiting for the LLM's `owner_done`
costs no latency**.

## 1. Turn-end rule (replace the current one in `turn-end.ts`)

- End the turn when the speculative LLM result for the current answer has arrived with `owner_done: true` **and**
  silence >= 1000 ms.
- End the turn when silence >= `TURN_END_HESITANT_MS` (3200) regardless.
- The word heuristic is used only when the speculative call failed (error), not when it is merely slow.
- Unit tests: slow LLM (2.5 s) + complete answer ends at 2.5 s, not 1.0 s; `owner_done: false` waits to 3.2 s;
  speech resuming at 2 s aborts and restarts; LLM error falls back to the heuristic.

## 2. Hedged turn requests for tail latency

If the turn LLM has not answered within `HEDGE_AFTER_MS` (default 1800), send the same request to the other provider
(Meta ↔ Baseten, whichever is not `TURN_LLM`) and use the first valid JSON; abort the loser. Log
`hedge: fired=<bool> winner=<meta|baseten> ms=<n>`. Only when both keys are configured. Unit tests with fake
providers: fast primary wins without a hedge, slow primary loses to the hedge, a failing primary falls to the hedge.

## 3. Keep the turn prompt small

Log the prompt size (characters) of each turn call. Pass only the last 6 conversation turns as `transcript_tail`
(older turns are not needed for the next question; the landmines and facts are passed separately).

## 4. Sim: fetch the front page from the new endpoint

The sim's `--debrief` still expects the front page in the POST response ("front page missing"). Poll
`GET /api/sessions/:sessionId/front-page` (202 → wait 1 s, max 90 s) and report debrief and front-page times
separately.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report. The director will re-run the sim.
