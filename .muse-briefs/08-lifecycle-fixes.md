# Brief 08: lifecycle and audio fixes from an independent code review

An independent reviewer read the repo (at commit 383bb3e). The verdict: tidy, strictly typed, with a strong
provider boundary and good fake-provider tests; the weak spot is **lifecycle**: cancellation, teardown, idle and
retry limits were never designed in. Fix these. Each item: a unit test that fails before the fix.
(Line numbers refer to 383bb3e; brief 07b may have moved code.)

1. **Second `start` leaks a session** (`server/src/index.ts` WS handler). A second `start` on the same socket
   overwrites `orchestrator` without stopping the old one, whose STT socket and keep-alive interval live forever.
   Also `orchestrator` is assigned only after awaits, so a disconnect during them starts a session with no client.
   Fix: stop any existing orchestrator on `start` (or reject the second `start`); check a `closed` flag after every
   await before calling `start()`.
2. **Sessions never end on their own.** Silence keep-alive keeps a paid realtime STT session open forever if the user
   walks away. Add `LISTEN_IDLE_MS` (default 60 000: listening with no speech at all, then end the session with a
   friendly `ended` message, "Session ended after a minute of silence.") and `MAX_SESSION_MS` (default 600 000).
3. **STT reconnect loop without limits** (`openSttWithRetry`, `speech-to-text.ts` handshake). The failure counter
   resets on every call, so a session that acks and then dies loops as fast as the network allows. The handshake
   does not close the socket on timeout or error and ignores `close` before the ack. Fix: one consecutive-failure
   counter per turn with exponential backoff (250 ms, 500 ms, 1 s; give up after 3, surface the error); close the
   socket on handshake failure; reject immediately on `close` before ack.
4. **`stop()` does not cancel in-flight work.** One `AbortController` per session, aborted in `stop()`; pass its
   signal to every LLM call (turn, speculative, interrupt), every `tts.synthesize` (fetch `signal`) and the news
   flash. Check `stopped` after every await. In the TTS adapter call `reader.cancel()` in a `finally` when the
   consumer stops early.
5. **News flash and reporter voices overlap.** `PcmPlayer.beginLine()` resets `nextTime = 0`, so the reporter's
   first chunk is scheduled 120 ms from now while seconds of news audio are still queued: both voices play at once.
   Then `playback_done` can fire while news is still playing. Fix: `beginLine()` re-arms the jitter delay only when
   `nextTime <= ctx.currentTime`, otherwise appends; `millisecondsUntilEnd()` covers everything queued. Test it.
6. **Mic worklet sends the wrong sample rate on 44.1 kHz devices** (`web/public/mic-worklet.js`). Integer `count >=
   ratio` averages 3 samples when the ratio is 2.756, producing 14.7 kHz audio labelled 16 kHz. Fix: proper
   fractional resampling (linear interpolation with a fractional position), with a unit-testable pure function for
   44.1 kHz and 48 kHz input.
7. **No `ws.onclose` in the browser.** A server restart leaves "Live. Listening." on screen. Show "Connection lost."
   with a "Start again" action.
8. **Session records keyed by scenario id** (if 07b has not already fixed it): "Try again" or a second tab overwrites
   the transcript and a debrief can grade the wrong session. Issue a session id on `start` (send
   `session_started { sessionId }`), key records and `POST /api/sessions/:sessionId/debrief` on it, one debrief per
   session.

Then run `npm run check` and `npm run smoke:voice`. The director will run `smoke:browserlike` (plain, `--ramble`,
`--fast-escalations`) against a live server. Small logical commits (include this brief), push, short report.
