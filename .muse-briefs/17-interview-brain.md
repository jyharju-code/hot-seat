# Brief 17: the interview brain (structure, memory, no circles)

The user's first real test after brief 16 (hot seat, Maple Corner Café, food poisoning) failed on the most
important thing: **the reporter goes in circles**. Transcript from `server/data/sessions-4c067fec-*.json`:

- The fridge alert (6:15, over 41 degrees for three hours) was asked **four times** (0:56, 2:10, 3:40, 5:06),
  although the owner admitted "Sure I did" the first time.
- Danny coughing at 8 am was asked **three times** (1:52, 3:24, 5:25), although the owner said "that was a
  mistake" and "it was not okay".
- Tom Hendricks was asked three times. The interview never reached what the owner does next, what changes in
  the kitchen, or the parent who will not bring her kids in.

Cause in the code: `JournalistBrain.nextTurn` sees only `history.slice(-6)` and the last three reporter lines.
There is no plan, no memory of what was asked or answered, and nothing decides when a topic is done. Each turn
is a fresh, stateless guess, so the landmines resurface forever.

Goal: a reporter that runs a **structured interview**: a plan, a memory, and rules that move it forward. The
code owns the structure. The model owns the wording and the judgement of each answer. Turn latency stays where
it is (one model call per turn, same race, same 8 s timeout).

Before you start, tag the current head `pre-brief-17` and push the tag.

## 1. Interview plan (once per session)

A plan of **5 ... 7 beats**, ready before the owner's first answer is committed. Never delay the opening
question for it.

- A beat: `id`, `goal` (what the reporter wants to get), `done_when` (what counts as answered, concrete),
  `max_questions` (2 or 3), optional `unlock_at_seconds` (landmines use their `reveal_after_seconds`),
  optional `landmine_id`, and `kind`: `facts | responsibility | landmine | human_impact | action | close`
  for hot seat, `origin | business_today | hard_years | people | future | close` for profile.
- Hot seat plan from the scenario: what happened, responsibility, each landmine as its own beat, the human
  impact (named people), the concrete action with a deadline, and a close. Order follows the reporter's
  temperament and agenda (a human-angle local reporter starts with the affected person).
- Profile plan: the five-stage arc in `profile-journalist-turn.md` made concrete for this business, plus close.
- Generate it with one Meta model call (new prompt file `prompts/interview-plan.md`, JSON, zod schema, 20 s
  timeout) started at session start, in parallel with the opening question. If it fails or times out, build
  a **deterministic fallback plan in code** from the scenario (landmines, agenda, arc). The session must never
  wait for, or fail on, the plan.

## 2. Interview state (server-side, per session)

A small, pure, unit-tested module (for example `server/src/session/interview-state.ts`), separate from the
orchestrator:

- Each beat's status: `open | active | answered | dodged | exhausted`, and how many questions it has had.
- `established`: short facts the owner has stated or admitted ("kept serving the chicken salad after the
  alert", "will compensate Emma's wages tomorrow"), each tagged with the turn.
- `commitments`: promises with a time, if any.
- `open_threads`: things the owner mentioned that are worth one follow-up (profile mode uses these a lot).
- `asked`: every reporter question so far, one short line each.
- Update the state **only from the committed line** of a turn, never from a speculative or aborted one.

## 3. Rules in code: what the next question is about

Before each turn the code computes a **directive** from the state and the clock:

- `PUSH` on the active beat while it is not done and under `max_questions`.
- `MOVE_ON` to the next eligible beat when the active beat is answered, or has reached `max_questions`
  (mark it `dodged` if the owner kept avoiding it, `exhausted` otherwise). An admission counts as answered.
- `CALLBACK`: return to a closed beat **only** for a real contradiction with something in `established`, at
  most once per interview. This is the one sanctioned "How can both be true?" moment.
- A beat whose `unlock_at_seconds` has not passed is not eligible yet. An escalation (news flash) puts its
  beat first.
- Pacing: give each remaining beat its share of the remaining time. If the active beat is over its share,
  `MOVE_ON` even if it is not done. In a 5-minute profile all beats must be touched before the wrap-up.
- **Never ask again about an answered beat or a fact in `established`.** Build on it instead ("You told me
  you kept serving it. Who decided that?") only inside the beat it belongs to.

## 4. The turn prompt gets the structure

Rewrite `journalist-turn.md` and `profile-journalist-turn.md` around the directive. Still one call per turn:

- In: the plan with statuses (one line per beat), the active beat (goal, `done_when`, questions used n/max),
  the directive and, for `MOVE_ON`, the next beat's goal, `established`, `commitments`, `open_threads`,
  every `asked` line ("never ask these again"), and the **whole** session transcript (compact; a session is
  short). Drop the six-turn tail.
- The model may judge that the owner's last answer already satisfies `done_when`. In that case it moves on
  itself, with a short natural transition ("Okay. Let's talk about what happens now.").
- Out, added to the existing JSON (keep `say`, `move`, `flags`, `quote_used`, `owner_done`, and the profile
  fields): `beat_id` (which beat this line serves), `answer_assessment` for the owner's last answer
  (`answered | partial | dodged | off_topic`), `new_established` (0 ... 3 short facts), `new_commitment`
  (or null), `new_open_thread` (or null). Zod schema in `shared`, optional fields so old records parse.
- The code validates: a line for a beat that is closed (and is not the one allowed `CALLBACK`) is a repeat.
  Then retry once with "You already covered that. Move to: <next beat goal>". If the retry also repeats, or
  time is short, use a deterministic transition question from the fallback plan for that beat.
- Keep the temperament, the repertoire and the spoken style. Keep the existing interrupt decision as it is.

## 5. Debrief: show the interview map

- Pass the plan and final beat statuses to the debrief. The debrief can then say exactly what was dodged
  ("You were asked about Danny once and admitted it. That stopped the questions.").
- In the debrief view, a compact **Interview map**: one row per beat, its goal in plain words, and its
  status (answered, dodged, not reached). Small and quiet, below the existing scores. This shows the
  structure the reporter followed.

## 6. Diagnostics for the next round

- The user also reports that **parts of their answers were not transcribed**. In the same transcript one
  answer ended mid-sentence ("The inner temperature of the salad") and one contains a leaked token
  (`<|speaker_A|>`). Strip `<|...|>` tokens from transcripts before they reach the brain or the record.
- Behind `DEV_TURN_LOG=1` (off by default, gitignored output under `DATA_DIR/dev/`), write per turn: the STT
  partials and finals with timestamps, the committed owner text, why the turn ended (silence, `owner_done`,
  max length), the directive, the beat and the model's assessment. No audio, no keys, no prompt text. We use
  this to find where answers are lost; do not change turn-end behaviour in this brief.

## 7. Sim and tests

- Sim report, per session: beats touched and their final statuses, **repeat count** (reporter questions that
  serve an already closed beat, excluding the one `CALLBACK`), and the longest run of questions on one beat.
- Unit tests for the state module and the directive rules: admission closes a beat, `max_questions` forces a
  move, unlock times, escalation priority, pacing, the single `CALLBACK`, no state change from a speculative
  line, the fallback plan when the plan call fails or times out.
- A replay test built from the Maple Corner transcript above (owner answers fixed, fake LLM that tries to ask
  about the fridge again): the code must stop the repeat.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report with the sim numbers you saw in unit tests and any design choices you made.
