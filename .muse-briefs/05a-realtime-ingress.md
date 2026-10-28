# Brief 05a: URGENT, live sessions die with "Ingress audio slower than real-time"

Human test in Chrome: right after the first reporter question the screen shows "Listening." and the error
**"Ingress audio slower than real-time"**, and the session is dead. The user says it got worse than before.
(Brief 05 was stopped before it changed anything; do this first, 05 comes after.)

## Root cause (reproduced by the director)

The server opens the Muse Voice Transcribe session in `beginListening()` as soon as it has *sent* the reporter's
TTS audio. ElevenLabs streams about 5x faster than real time, so the browser is still *playing* the question for
5 to 8 seconds, and during playback it sends no mic frames (half duplex). Muse Voice Transcribe measures audio
received against wall-clock time since the session opened; after the gap it fails the session with
"Ingress audio slower than real-time". The orchestrator then never recovers. Since brief 03 the opening question
needs no LLM call, so the gap is longer and the bug hits on the very first turn.

Repro the director used: a Node client that, after `state: listening`, waits for the duration of the received
reporter audio (bytes / 48 per ms) before streaming the answer. The session errors about 15 s later.

## Fix

1. **Open STT only when the browser is really listening.** The client sends `{ "type": "playback_done" }` when
   the reporter audio has finished playing (after the PCM player's scheduled end). The server goes to
   `listening` and opens the STT session only on `playback_done`. Until then the server state stays `speaking`.
   Add the message to the shared zod protocol.
2. **Never leave an open STT session without audio.** From the moment an STT session is open until it is
   closed, the client streams mic frames continuously every ~100 ms. The browser keeps capturing during playback;
   while the reporter is speaking it sends nothing (session closed anyway). On the server, if a session is open
   and no client frame has arrived for 300 ms, push 100 ms of silence (zeros) to keep ingress real-time.
3. **Recover instead of dying.** If the STT session errors or closes unexpectedly while listening, log it,
   open a new session and keep listening without showing an error. Show an error to the user only if two
   reopen attempts in a row fail. Keep the answer text already collected in the current turn.
4. **Smoke that behaves like a browser:** `npm run smoke:browserlike`: connects to a running server URL given as
   an argument (default `ws://127.0.0.1:3001/ws`), creates a scenario via `POST /api/scenarios`, plays the role of
   the browser including the real playback delay, sends `playback_done`, then streams a spoken answer synthesized
   with ElevenLabs at real-time pace, for three turns. It prints each event and fails on any `error`. You cannot run
   it (no listening server in your sandbox); the director will. Keep it small and readable.
5. Unit tests with a fake STT that fails when there is a gap of more than 1 s without audio: no STT session is
   opened before `playback_done`; silence keep-alive is pushed; an STT error mid-turn reopens the session and the
   turn continues.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical commits
(commit briefs 05 and 05a too), push to `origin main`, short report.
