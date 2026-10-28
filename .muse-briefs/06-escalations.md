# Brief 06: escalations during the interview

The front page now tells the right story (director checked the image: café crisis, owner quotes, the landmine
in the subhead). Next: make the interview feel alive. Real crises move while you talk: a new post, a review,
a call from the inspector. Wonder already writes `escalations` into every scenario
(`at_seconds`, `news_flash`, `gives_journalist`, `new_fact`); they are stored but unused.

## Behaviour

1. When `at_seconds` has passed since the session started, the escalation **fires at the next turn boundary**
   (never while the user is speaking or the reporter is mid-line): right after the user's answer has been taken,
   before the reporter's reply.
2. The server sends `{ "type": "news_flash", "text": news_flash, "atSeconds": n }`. The web shows it as a single
   line in a strip above the headline: ink on `--ground-dark`, small "NEW" label in bold, no colour, no animation
   except appearing. It stays until the next news flash. Add it to the transcript too, as a third role "news".
3. The reporter learns the `new_fact` at that moment: add it to `{landmines_known_to_you}` for the journalist named
   in `gives_journalist` with the instruction line already in the prompt. The reporter's next line should usually
   confront the user with it.
4. The news flash is also **spoken** in a short radio voice before the reporter speaks: ElevenLabs voice Daniel
   `3WqHLnw80rOZqJzW9YRB`, model `eleven_v4_turbo` (faster), plain text without tags. Then the reporter speaks.
   Both clips stream to the browser in order; `audio_end` comes once after both. The browser's
   `playback_done` logic stays the same.
5. At most one escalation per turn. If several are due, fire the earliest; the rest wait for later turns.
6. The debrief gets the news flashes in `{events}` with their mm:ss times.

## Tests and smoke

- Unit: escalation fires at the first turn boundary after `at_seconds`, not before; only one per turn; the
  journalist prompt receives the new fact; message order is news_flash, news audio, reporter_line, reporter audio,
  audio_end.
- Extend `smoke:browserlike` with `--fast-escalations`: the server accepts an optional `escalationScale` in the
  `start` message (only when `NODE_ENV !== "production"`) that multiplies `at_seconds` (e.g. 0.1), so a
  three-turn smoke sees at least one news flash. The director will run it.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical commits
(include this brief), push to `origin main`, short report.
