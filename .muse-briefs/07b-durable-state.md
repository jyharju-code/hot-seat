# Brief 07b: state survives restarts, interrupts survive reopens

## 1. "Unknown scenarioId" (human test)

The user built a scenario, then pressed "Take the seat." and got `Unknown scenarioId`. Scenarios live in an
in-memory map, and the dev server restarted in between. Any restart or deploy will do the same in production.

- Store scenarios and finished session records (transcript, events, debrief) as JSON files under `DATA_DIR`
  (env, default `./data`, gitignored), one file per id, written atomically (write temp file, rename).
  Keep a small in-memory cache in front. Validate on read with the zod schemas.
- Put this behind a tiny `Store` interface so a database can replace it later. Unit tests with a temp dir:
  write, read after a "restart" (new instance), invalid file rejected, unknown id.
- If `start` still gets an unknown id, the browser shows "This scenario has expired. Build it again." with the
  Setup button, not a raw error.

## 2. Interrupt did not fire in `smoke:browserlike --ramble` (director ran it)

Result: no `interrupt`; the server log shows
`[stt] session error while listening: Ingress audio slower than real-time; reopening`, then the turn ended
after the first sentences and the reporter replied normally.

Two causes:
- The smoke paces audio with `sleep(100)` per 100 ms frame, which drifts slower than real time over 35 s.
  Pace by absolute clock: frame n is sent at `t0 + n * 100 ms`.
- After an STT reopen the orchestrator loses the answer's start time and partial-text history, so interrupt
  decisions restart from zero and the turn-end deadline misfires. A reopen inside one answer must keep: the
  answer start time, collected finals, the last partial text (prefix new partials with the collected text),
  and the interrupt bookkeeping. Unit test: reopen at 12 s of a rambling answer, interrupt still fires.

For reference, the raw Muse Voice Transcribe events (director captured them): the ack has no `type`
(`{"sessionId": ...}`), then `speechStart`, many `transcript` events with `"final": false` and the cumulative
text in `transcript`, then `speechEnd` and `speechComplete` (`transcript` = final text). In a 12 s answer
`speechComplete` arrived only once, at the end.

Same rules. `npm run check`, small commits (include this brief), push, short report.
