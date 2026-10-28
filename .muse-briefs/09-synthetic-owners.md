# Brief 09: synthetic owners, so we can polish until it is smooth

The user wants to rehearse with Hot Seat and judge its *fluency*. Before a human spends time on it, we test it
with **synthetic owners**: an AI plays the business owner, speaks out loud at real-time pace with natural
pauses, and we measure everything. We then fix what the measurements show and run again. This tool also stays
in the repo as evidence of how we tested.

## 0. First, an interrupt bug the director just found (brief 08b verified on a live server)

Decisions now work: the server log shows `decision latency 1035..2097ms interrupt=true`, followed every time by
`stale decision dropped (answer moved on)`. While the decision is in flight the owner keeps talking, so the partial
text has always grown and every decision is thrown away. A rambling answer that keeps going is still rambling.
Rule: a decision is stale only if the answer **ended** (turn closed) or a **new answer** started. If the current
partial starts with the text the decision was made on, act on it. Unit test.

## 1. `npm run sim` (in `server/scripts/sim/`, small modules, typed)

Connects to a running server (`--url`, default `ws://127.0.0.1:3001/ws`) exactly like a browser does
(scenario via `POST /api/scenarios`, `start`, wait for real playback time of reporter audio, `playback_done`,
mic frames at real time by absolute clock, 100 ms frames, PCM16 16 kHz).

- **Owner agent:** Muse Spark (`muse-spark-1.3`, reasoning minimal, `maxTokens` >= 1500) writes the owner's next
  spoken answer from: the persona profile, the scenario `briefing_for_user`, the conversation so far, and the
  reporter's last line. It returns JSON `{ "segments": [{ "text": "...", "pause_after_ms": 0..2500 }] }` so pauses
  inside an answer are explicit.
- **Owner voice:** ElevenLabs `eleven_flash_v2_5` (cheaper), `output_format=pcm_16000`, one stable voice per
  session (male `TX3LPaxmHKxFdv7VOQHJ` or female `XrExE9yKIg1WjnnlVkGX`, either is fine). Silence is inserted for
  `pause_after_ms`. If an `interrupt` event arrives, stop speaking immediately (as a person would).
- **Profiles** (each a short Markdown persona in `server/scripts/sim/profiles/`):
  `prepared` (direct, owns it, concrete actions), `evasive` (scripted lines, deflects), `rambler` (long, repeats
  itself; should get interrupted), `hesitant` (thinks aloud with 1.0 to 2.5 s pauses mid-answer; must NOT be cut
  off), `terse` (one-sentence answers), `contradicts` (states things that contradict the briefing).
- **Metrics per turn** (client-side, measured by the sim):
  - `latency_ms`: end of the owner's last speech frame to the first reporter audio byte (what a human feels),
  - `split`: the owner's single answer arrived as more than one `transcript` (turn cut too early),
  - `wer`: word error rate of the server transcript against the text the owner spoke (normalised, punctuation-free),
  - `interrupted`, `errors`, `reporter_words`, `repeat`: the reporter asked essentially the same question as in
    the previous turn (normalised text similarity > 0.8).
- **Report:** `sim-results/<timestamp>/report.md` and `results.json` (gitignored): one table row per profile with
  median and worst latency, splits, mean WER, interrupts, repeats, errors, and the full transcript per session
  below. Print the summary table to stdout.
- **CLI:** `npm run sim -- --profiles all|a,b --turns 4 --concurrency 3 --preset cafe_food --debrief`.
  `--debrief` ends one session with End and requests the debrief and front page, reporting their times.
  **Cost guard:** estimate TTS characters before starting, print it, and refuse to run above `--max-chars`
  (default 20000) unless raised.
- Unit tests for the pure parts: WER, split detection, repeat detection, pacing schedule with pauses, stop on
  interrupt.

You cannot run `npm run sim` (no listening server in your sandbox); the director will run it and send you the
reports. Same rules: never print keys, no elevated retries. `npm run check`, small commits (include this brief),
push, short report.
