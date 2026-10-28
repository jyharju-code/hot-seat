# Brief 13: the friendly profile interview

Product decision from the user: a second, very different kind of rehearsal. The hot seat teaches people to survive
a hostile reporter. The profile interview teaches the opposite lesson: **the friendly reporter is the dangerous
one.** The conversation feels warm and easy, and the damage only shows up the next morning in the paper.

## 1. Mode and duration

- Setup view: choose **Hot seat** (crisis, hostile reporter, today's flow, unchanged) or **Profile interview**
  (friendly, 5 or 10 minutes; the user picks the length, default 5).
- `format` gains `"profile"`; the scenario stores `duration_minutes` (5 or 10). Old scenarios still load.
- Profile presets (one line each, like today's presets): a café's tenth anniversary, a design studio that just
  won an award, a renovation company expanding to a second town, a family restaurant handing over to the next
  generation, a web store founder named "entrepreneur of the year", a sports club celebrating a record season.
  The user can also type their own.

## 2. Director for profiles (`prompts/profile-director.md`, same JSON shape where possible)

- An occasion, not a crisis: the paper is writing a warm feature about the owner and the business.
- **3 sensitivities**, using the existing landmine structure with `owner_knows: true` for all 3: things a
  candid owner might let slip when relaxed (a falling-out with a former partner, staff turnover, a supplier they
  quietly blame, a competitor they despise, money trouble behind the success story, a shortcut they are proud of
  that is actually a problem). Written in the second person. They are shown in the briefing under "Things you
  would rather not see in print". The reporter does **not** know them; the reporter's job is to draw them out.
- The reporter: warm, curious, generous with compliments, a good listener, laughs, shares a little about
  themselves. A local paper's features writer or a business magazine. Voice from the same temperament table
  (`human`).

## 3. Profile reporter (`prompts/profile-journalist-turn.md`)

- Arc over the session: life story and why they started → the business today → the hard years → people (staff,
  partners, competitors, customers) → the future. Use the remaining time (pass `elapsed_seconds` and
  `duration_seconds`) to pace this.
- Never confront, never challenge, never interrupt (interrupt decisions off in this mode, escalations off).
- When the owner says something candid, careless or quotable, warmly invite more ("Oh, tell me more about
  that.", "That must have been hard. What happened?"). Make the owner feel safe. Never say anything is off the
  record.
- Internal output per turn, hidden from the UI: `quote_harvest`: the owner's exact words worth printing, or
  null, and `angle`: the story the reporter is quietly building. Keep `owner_done` and the same JSON contract
  otherwise. Max 30 words spoken, one question.
- Time: about 45 seconds before the end, the reporter starts wrapping up ("We're nearly out of time, one last
  question..."). At `duration_seconds` the reporter thanks them warmly and the session ends by itself (a new
  server event `session_complete`; the client goes to the debrief as if End was pressed). `MAX_SESSION_MS` must
  allow 10 minutes plus a margin.

## 4. Debrief and front page for profiles

- The debrief prompt gets the mode. For profiles, add a section **"What you gave away"**: the quotes the reporter
  harvested, how the paper will frame each one, and a better way to say the same thing warmly and safely.
  Landmine statuses work as today (`disclosed_proactively` here means the owner handled a sensitivity
  gracefully on their own terms; `raised_and_fumbled` means they let it slip in a damaging way).
- Add a profile section to `prompts/coach-knowledge.md`: rapport-based interviewing, "everything is on the
  record", the danger of speculating about other people, the long silence, flattery. Same source rules as brief
  12: only sources you actually opened, with DOI or URL, added to `docs/research/crisis-communication.md`; if
  you find none, write it as practice guidance and say so.
- The front page for a profile is a feature page, not a crisis page: a friendly layout, the owner's photo, but the
  headline and pull quote built from the most damaging harvested quote ("'Honestly, my old partner nearly
  killed this place'"). The contrast between the warm layout and the headline is the point.

## 5. Tests and sim

- Unit tests: format and duration parse, old scenarios load, interrupts and escalations off in profile mode, wrap
  up at duration minus 45 s, `session_complete` at duration, harvested quotes reach the debrief input.
- Sim: `--mode profile --duration 5` works with the existing profiles. Keep the cost guard (a 5-minute profile
  uses more TTS characters; estimate accordingly).

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
