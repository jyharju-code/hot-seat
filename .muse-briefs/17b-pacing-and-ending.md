# Brief 17b: pacing, the end of the plan, and no canned loops

Verification of brief 17 at `77abd69`. Hot seat is much better: the reporter moves through the beats, at most
three questions per beat, 0 repeats, and it notices a stock phrase ("That's the third time you've said robust
processes"). Three problems, the first one serious.

## 1. Profile: the plan ran out at half time, then a canned line looped (serious)

5-minute profile sim (`profile_cafe_anniversary`, prepared owner):

- Every beat got **one** question: origin 0:00, first month 0:21, today 0:46, hard years 1:09, people 1:37,
  future 1:55, and the reporter **thanked and closed at 2:38** of 5:00.
- Then the deterministic fallback said **"Let's move on. What happens next?" seven times** (3:14 ... 4:53),
  the same words every time, with the wrap-up question once in between.

Fixes:

- **Profile beats need depth before they close.** Add `min_questions` (profile: 2, hot seat: 1). A profile
  beat cannot close as answered below its minimum, and the follow-up should dig into what the owner just said
  (an `open_thread`, a named person, a feeling). The candid-quote harvest depends on these follow-ups.
- **The close beat is locked until the wrap-up time** (profile: duration minus 45 s; the existing wrap-up and
  `session_complete` stay the only way a profile ends). The reporter never thanks or says goodbye before it.
  Validate in code: a line that reads as a goodbye (reuse `isWrapUpLine` or similar) before the wrap-up time
  is rejected like a repeat.
- **Pacing is a ceiling, not a target.** Moving on early because a beat was answered is fine in hot seat. In
  profile, when the beats are done before time, go back to the richest `open_threads` and to the people beat
  ("You mentioned Maya and Tom. What are they like to work with?"), never to a closed beat's original question.
- **Canned fallback lines must be beat-specific and never repeat.** Each fallback beat carries 2 ... 3
  transition questions written for that beat (profile ones warm, hot seat ones sharp). Never speak the same
  reporter line twice in a session: the code checks every line against `asked` (normalised text) before
  speaking. If every option is used, ask about an open thread; if there are none, the generic line is a
  short, warm "Tell me more about that." in profile, or the plan-exhausted ending below in hot seat.
- Unit test: a 5-minute profile replay with an owner who answers every question fully must touch all
  content beats, with at least 2 questions each, no goodbye before duration minus 45 s, no repeated line.

## 2. Hot seat: end the interview when the plan is done

In the prepared hot seat sim the reporter closed properly ("Thank you for speaking to me. I'll put all of that
to Diane, to George, and to our readers today.") and then said "Let's move on. What happens next?".

- When the close beat has been spoken in hot seat, the session ends the same way a profile does: send
  `session_complete` (the close line is the message, no second thank-you), the client speaks it and goes to
  the debrief. The user can still end earlier with the existing button.
- If the user keeps a hot seat going long with no plan left, the reporter does the close beat instead of
  inventing new topics.
- Sim: hot seat sessions that end this way count as a normal end (as profile sessions already do).

## 3. Scenario generation: one retry

One sim session failed at the start: `[scenario] generation failed after 60007ms: The operation was aborted due
to timeout`, and the client got a 502. A first impression that fails is the worst failure in a demo.

- Retry the scenario director once on a timeout or network error (log `[scenario] timeout, retrying`), as the
  debrief does. Keep the 60 s timeout per attempt.
- The setup view shows a calm "Still writing your scenario..." after 20 s, and on a final failure a
  "Try again" button that keeps what the user typed.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
