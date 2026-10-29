# Brief 18b: interrupts count, and a text-based repeat guard

Narrow brief. Found in the user's real hot seat test at `1242901` (session `b73e3d86`, football club). The
interview structure worked well overall, but one topic was asked **five times** in 95 seconds:

- 3:39 "Your own screening form, blank in Danny's file three seasons on. Why did YOU skip it?" (labelled
  `responsibility` by the model, although it is landmine L2)
- 4:17 interrupt: "Why was the form blank, though?"
- 4:33 "Process? Every other coach's form is filled in. Why is Danny's the ONLY one blank?" (L2)
- 4:52 interrupt: "But why is Danny's form blank?"
- 5:14 "Three seasons ago, rushed, two weeks before kick-off. His screening form still blank. Why did YOU sign
  that off?" (L2)

The final beat state says `landmine-L2 dodged 2`, so the guard saw only two questions. Two causes.

## 1. Interrupts live outside the interview brain

The interrupt cut-in (`server/src/interrupt.ts`, `prompts/interrupt-decision.md`, used from
`server/src/session/orchestrator.ts`) never reads or updates the interview state.

- An interrupt counts as one question on the active beat (update the state when the cut-in is actually
  spoken, not when the decision is made).
- **At most one interrupt per beat.** Do not ask the decider at all when the active beat has already had one,
  or when the beat is at `max_questions`.
- Give the interrupt prompt the active beat's goal and the `asked` lines ("never repeat these"), so a cut-in
  presses in a new way (quote their own words, name the evasion) instead of re-asking the same question.
- After an interrupt on a beat, the next normal turn's directive treats that beat as one question closer to
  its limit, so a dodged beat moves on sooner.

## 2. Repeat guard by text, not only by the model's beat label

The model labelled a screening-form question as `responsibility`, so `isRepeatLine` (which trusts `beat_id`)
missed it.

- Add a content-word overlap check in `server/src/session/interview-state.ts`: normalise (lowercase, strip
  punctuation and audio tags), drop stop words, compare the new line with every earlier reporter line
  including interrupts. If the overlap with a line from a **different or closed** beat is high (for example
  Jaccard of content words at or above 0.5, or the same key noun phrase from a landmine fact such as "screening
  form"), treat the line as serving that earlier beat: count it there, and if that beat is closed or at its
  limit, it is a repeat and goes through the existing retry and fallback path.
- Also assign `beat_id` in code when the model's label disagrees with an obvious landmine match: a line that
  contains the distinctive words of a landmine fact serves that landmine's beat.
- Keep it cheap: no extra model call.

## 3. Tests

- Replay of the five lines above with fixed owner answers: at most two normal questions plus at most one
  interrupt on the screening form, then the interview moves on.
- Unit tests for the overlap check (the two interrupt lines above must match the 3:39 line; "What will you send
  parents in writing by eight tonight?" must not match "Will every parent have that in writing by eight
  tonight?" as a different beat, because both are the same `action` beat and the beat is still open).
- An interrupt is not offered on a beat that already had one.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
