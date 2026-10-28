# Brief 11: findings from the second human test

The user played the design-agency scenario (unpaid overtime). Verdict: the debrief is good, the reporter is good,
but three things broke the experience.

## 1. A failed turn leaves the session stuck forever (highest priority)

The UI showed "Listening." plus a red "fetch failed", and nothing happened after that. The user had to press End.
Server log: the turn LLM race finished (`race: winner=meta ms=1554`), then no `[turn 8]` timing line, no audio,
and **no error in the server log at all**. `Orchestrator.fail()` only sends `{type:"error"}` to the client; it
neither logs nor recovers. "fetch failed" is undici's generic network error, most likely the ElevenLabs request.

- `fail()` logs at error level with the stage (`stt|turn_llm|tts|interrupt|escalation`) and `err.cause` (undici
  hides the real reason there). Never log keys or full URLs with query strings.
- Retry a failed TTS stream once (new request, same text) and a failed turn LLM once, if the turn is still current.
- If the retry also fails, **recover instead of hanging**: the reporter says a short pre-rendered line ("Sorry,
  my line dropped. Let me ask that again.") or, if TTS itself is down, the text is shown and the server goes back
  to listening. The client error line is replaced by a gentle "Connection hiccup, carrying on." Only a failure
  that cannot recover (STT reopen exhausted) ends the session, with a clear message and the End button highlighted.
- Unit tests with fake providers: TTS fails once then succeeds, TTS fails twice → recovery line and back to
  listening, LLM fails once then succeeds. No test may leave the state machine without a next state.

## 2. The reporter repeats the same move across scenarios

"That's not a yes or no. Did you ...?" appeared again, almost word for word, in a different scenario. One move
over and over makes every reporter feel like the same person.

- Journalist prompt: list a repertoire of moves and say to vary them. Demand a yes or no **at most once per
  interview**. Other moves: quote their own words back, cite a specific document or number, read out what a
  named customer or ex-employee told you, ask the human-impact question ("What do you say to Ben?"), offer a
  tempting wrong frame for them to accept or reject, short silence then "Is that all?", ask what they will do by
  a specific day.
- Pass the reporter's own last 3 lines into the prompt as `your_recent_lines` with "never reuse their opening
  words or structure".
- Director: the reporter's temperament, voice and agenda should follow from the outlet and the story, not
  default to "relentless". Local papers often lead with the human angle and get sharp later.

## 3. Long waits mid-interview

Turns 6 and 7 took `speechEnd->firstAudio` 10612 ms and 8021 ms, with many speculative restarts (`[turn] prompt
chars` every 0.5 to 1 s while the owner spoke with short pauses). Find out from the code why `speechEnd->llm` can
reach 9.8 s: whether `speechEndAt` is the first endpoint of a resumed answer (so the number is inflated) or
whether the owner really waited that long. Fix the measurement if it is wrong. If the wait is real, cap the
time from the last speech to the reporter's voice at about 4 s (accept the latest speculative result, or start
the final call immediately). Unit test the cap.

## 4. Small fixes

- Owner-known landmines are written in the third person ("The owner was warned..."). Director: write
  `fact` for owner-known landmines in the second person ("You got an alert...").
- Debrief took 84981 ms in this session (14.5 s before brief 10). Log the debrief prompt size in characters and
  the model call time separately so we can see why.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
