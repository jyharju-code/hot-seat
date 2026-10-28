# Prompts

All prompts live here as Markdown files and are loaded at runtime by the server
(see `loadPrompt` in the server prompts module). Never hard-code prompt text in
TypeScript: edit the Markdown file instead, and restart or reload the server to
pick the change up.

Naming: use short lowercase names with hyphens, for example `scenario-build.md`
or `reporter-question.md`.

## Provenance

These prompts were drafted before the hackathon (prior work) and refined here.
They are part of the pre-hackathon prompt and voice drafting mentioned in the
repository README; no code came with them.

## Files

- `spoken-style.md`: rules for lines that go straight to a text-to-speech voice.
  It is spliced into the reporter prompts as `{spoken_style}`.
- `journalist-turn.md`: one reporter turn. Fill `{name}`, `{outlet}`,
  `{temperament}`, `{agenda}`, `{public_facts}`, `{transcript_tail}`,
  `{last_answer}` and `{spoken_style}` at runtime.
- `opening-question.md`: same persona, no `last_answer`; asks the first
  question about the scenario.
- `interrupt-decision.md`: whether the reporter should cut in now. Fill
  `{name}`, `{outlet}`, `{question}`, `{seconds}`, `{partial}` and `{facts}`.
- `debrief.md`: the coach's debrief. Fill `{scenario_json}`, `{transcript}`,
  `{events}` and `{language}` at runtime.
- `front-page.md`: the Muse Image prompt for tomorrow's front page. Fill
  `{paper_style}`, `{fictional_paper_name}`, `{tomorrow}`, `{headline}`,
  `{subhead}`, `{company_name}`, `{crisis_summary}`, `{key_facts}` and
  `{quotes}` at runtime.
