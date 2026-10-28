# Brief 10: fair landmines and a fuller briefing

First real human test: "this is hard-hitting!" But the debrief said, for all three landmines, "Not handled. Never
mentioned. You never disclosed the customer list exported eight months ago..." The user had never heard of any of
them. They also said the briefing was thinner than they expected walking in.

Two causes:
- The director prompt defines landmines as facts "the spokesperson has not been told", and none of them are in the
  briefing. Yet the debrief scores the owner for not disclosing them.
- Landmines reach the reporter at `reveal_after_seconds` (60 / 180 / 300 typical). In a short session the reporter
  never learns them, never raises them, and the debrief still marks them "not handled".

A real owner knows their own skeletons (an old export left in a shared folder, a login alert someone dismissed).
Rehearsing how to handle what you know but have not said is the most valuable part. One genuine surprise keeps the
tension.

## 1. Scenario: who knows what

- `landmineSchema` gains `owner_knows: boolean` (zod default `false`, so stored scenarios still load).
- Director prompt: of the 3 landmines, **2 are things the owner knows** (their own uncomfortable facts, which the
  press does not have yet but a reporter can dig up) and **1 is a surprise** the owner has not heard of. Each stays
  fair: a well-prepared owner could handle it.
- Timing that fits a short interview: `reveal_after_seconds` between 30 and 150, spread out (for example 40, 90,
  150). Journalist prompt: once a landmine is known to you, confront the owner with it within your next two
  questions.
- Update the café fixture accordingly.

## 2. A fuller briefing

- `briefing_for_user`: 6 to 8 concrete bullets: what happened with times, numbers and names, what has been done so
  far, what is still unknown, who is upset and where.
- The Briefing view shows three short sections: **What happened** (`briefing_for_user`), **What's already public**
  (`public_facts`), **What you know that the press doesn't, yet** (the `owner_knows` landmines, in plain words).
  The surprise landmine is never shown before the session.

## 3. Debrief judges only what was fair to judge

- The server passes the debrief prompt the session length and, per landmine, `owner_knows` and whether it was
  revealed to the reporter during the session (`reveal_after_seconds` <= elapsed).
- Debrief landmine result becomes `{ "id", "status", "comment" }` with status
  `disclosed_proactively | raised_and_handled | raised_and_fumbled | not_raised`. Rules in the prompt:
  - Never blame the owner for not mentioning a surprise landmine the reporter did not raise.
  - An `owner_knows` landmine that nobody brought up is `not_raised`; the comment is neutral coaching ("Worth
    preparing: ..."), not a failure. Bringing it up first and well is `disclosed_proactively` and is praised.
- Stored debriefs with the old `handled: boolean` shape must still load and render.
- Debrief view: show each landmine's fact and a status label; `not_raised` is styled neutral, not as a failure.

Unit tests: schema default for `owner_knows`, briefing shows only owner-known landmines, debrief input marks
revealed landmines correctly for a short and a long session, old debrief shape still parses.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
