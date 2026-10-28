# Brief 07: the reporter cuts in

Escalations work: the director ran `smoke:browserlike --fast-escalations` against a live server and saw two news
flashes, each followed by a reporter line confronting the owner with the new fact. One small bug first:

0. `npm run smoke:browserlike -- --fast-escalations` from the repo root drops the flag (the root script calls the
   workspace script without forwarding arguments). Forward arguments in all root `smoke:*` scripts.

## Interruptions

Real reporters do not wait politely through a 40-second non-answer. This is the feature people will remember.

1. While listening, after the owner has spoken for at least 8 s in the current answer, run an **interrupt
   decision** every 1.5 s when the partial text has grown since the last decision. One decision call in flight at a
   time; drop stale results (the answer moved on). Use the turn LLM (`TURN_LLM`), `reasoning_effort: "minimal"`.
2. If the decision says `interrupt: true`: close the STT session, treat the partial text as the owner's (cut-off)
   answer, send `{ "type": "interrupt", "say": ... }`, synthesize the cut-in with `eleven_v4_turbo` in the
   reporter's voice and stream it at once, then `audio_end`. The browser stops sending mic audio when it receives
   `interrupt` (state `speaking`) and plays the cut-in; `playback_done` returns to listening as usual. The cut-in
   *is* the reporter's next question.
3. Limits: at most one interruption per answer, never two answers in a row, env `INTERRUPTS=on|off`
   (default on). Never interrupt within 8 s of the answer starting.
4. Transcript: the owner's cut-off answer ends with " (cut off)"; the cut-in shows as a reporter line. Debrief
   `{events}` gets `[mm:ss] Interrupted: reason`.
5. Timing: log decision latency and time from decision to first cut-in audio.

## Prompt `prompts/interrupt-decision.md`

```text
You are the room. A small business owner is answering this question from {name} of {outlet}: "{question}"
They have been talking for {seconds} seconds. Their words so far: "{partial}"

Should the reporter cut in NOW? Interrupt only when a real reporter would:
- over 25 seconds without answering the question asked,
- repeating a scripted line a second time,
- an obvious dodge ("I'm not going to speculate") followed by a pivot,
- a claim that contradicts these facts: {facts}.
Otherwise let them talk.

Return ONLY JSON:
{"interrupt": true, "reason": "short",
 "say": "very short spoken cut-in, max 12 words, starts with [interrupting]"}
```
(`interrupt` false → `say` may be empty.)

## Tests and smoke

- Unit with fake STT and fake LLM: no decision before 8 s; decisions only when partial text grew; stale result
  ignored; interrupt closes STT and plays the cut-in; one per answer, not on consecutive answers; `INTERRUPTS=off`.
- `smoke:browserlike --ramble`: in turn 2 the "owner" answers with a long scripted non-answer (about 35 s of
  synthesized speech that never answers the question and repeats "we take this very seriously"), streamed at real
  time; the smoke expects an `interrupt` event and stops streaming when it arrives. The director will run it.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical commits
(include this brief), push to `origin main`, short report.
