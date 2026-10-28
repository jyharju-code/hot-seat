# Brief 02: the first voice loop

Goal: one reporter questions the user out loud, end to end, in English. This is the spine every later feature
hangs on, so keep it clean and measurable. No scenario generator yet, no multiple reporters, no interruptions.

## Environment notes

- `.env` now exists with real keys (`MODEL_API_KEY`, `ELEVENLABS_API_KEY`, `SONIOX_API_KEY`, `BASETEN_API_KEY`).
  Never print, log or commit a key value. Log only whether a key is present.
- Your sandbox cannot open listening ports, so do not run `npm run dev`. Outbound network works, so live
  provider calls from scripts and tests are fine. The director runs the browser test outside the sandbox.

## The loop

```
browser mic ──PCM16 16 kHz──▶ /ws ──▶ SpeechToText (Muse Voice Transcribe, ENDPOINTING)
                                          │ final transcript of the user's turn
                                          ▼
                                   Llm (Muse Spark, journalist prompt) ──▶ JSON {move, flags, say, quote_used}
                                          │ say
                                          ▼
browser speaker ◀──PCM 24 kHz── /ws ◀── TextToSpeech (ElevenLabs eleven_v4, streaming)
```

Half duplex for now: while the reporter speaks, the browser stops sending mic audio. Use
`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`.

## Adapters to implement

### SpeechToText: Muse Voice Transcribe (realtime)

- `wss://api.meta.ai/v1/asr/realtime`. First message is a JSON handshake:
  `{"mode":"ENDPOINTING","authorization":{"accessToken":MODEL_API_KEY},"audioEncoding":"PCM_16KHZ","model":"muse-voice-transcribe-1.0","partialMode":"CUMULATIVE","emitAudioProgress":false,"languageBias":["English"]}`
- Wait for the ack. A message with `type: "error"` means failure (`message` field).
- Then send raw PCM16 mono 16 kHz little-endian as binary frames (about 100 ms each). End with `{"type":"endStream"}`.
- Events are JSON with `type`. Known: `speechEnd` (endpoint detected), `speechComplete` (`turnId`, `transcript`:
  the final text of one turn). There are also partial-transcript events; log unknown `type`s once at debug level
  and expose partials through the port as `onPartial` (the interrupt feature will need them later).
- Expose it as an async session object: `push(pcm)`, `end()`, callbacks or an async iterator for
  `partial`, `endpoint`, `final`, `error`.

### TextToSpeech: ElevenLabs

- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000`,
  header `xi-api-key`, body `{"text", "model_id":"eleven_v4", "voice_settings":{"stability":0.3,"similarity_boost":0.85}}`.
- The text contains inline audio tags like `[impatient]`; pass them through unchanged (v4 performs them).
- Stream chunks out as they arrive; do not buffer the whole clip.
- Voices are config, not code: put them in `server/src/voices.ts` (or JSON) keyed by role. For now:
  `relentless: { name: "Walter", voiceId: "9ZbFvrGBxO3uSmsw6wdI" }`.

### Llm: extend the Meta adapter

- Journalist turns use Muse Spark `muse-spark-1.3` with `reasoning_effort: "minimal"` and a generous
  `max_tokens` (at least 1500; reasoning counts against it and too low a value returns empty content).
- Structured output: parse the JSON, validate with zod, retry once on invalid JSON.

## Prompts

Create these files; load them at runtime and fill `{placeholders}` with a tiny template function (no library):

`prompts/spoken-style.md`:

```text
SPOKEN STYLE RULES (the text goes straight to a text-to-speech voice):
- Write how a real person talks, not how they write. Short sentences. Fragments are fine.
- Use natural spoken fillers sparingly ("look,", "so,", "okay,").
- Steer delivery with inline audio tags in square brackets, placed right before the words they affect:
  [impatient] [interrupting] [sharply] [scoffs] [sighs] [hesitates] [rushed] [slows down]
  [skeptical] [deadpan] [laughs] [short pause] [long pause]
  Use 1 to 3 tags per line. Never stack more than two tags in a row.
- Write numbers as words.
- Spell out abbreviations the way they are pronounced.
- Use ALL CAPS for at most one stressed word per line.
- No stage directions outside tags, no emojis, no markdown.
```

`prompts/journalist-turn.md`:

```text
You are {name} from {outlet}, a {temperament} reporter interviewing a small business owner about a crisis.
Your agenda: {agenda}.
Scenario facts you know: {public_facts}
Conversation so far (most recent last): {transcript_tail}
The owner just said: "{last_answer}"

Decide your next move and write what you SAY out loud.
- If they dodged, call out the dodge and re-ask, shorter and sharper.
- If they contradicted a known fact or an earlier statement, quote their own words back at them.
- If they gave a strong, specific answer, acknowledge briefly and move to your agenda.
- Max 30 words. One question only. Stay in character. Never help the owner.

Return ONLY JSON:
{"move": "follow_up|new_angle|confront|pass",
 "flags": ["dodge|contradiction|speculation|blame_shifting|empathy_missing|strong_answer"],
 "say": "spoken line, follows the spoken style rules",
 "quote_used": "exact words of the owner you quoted, or null"}

{spoken_style}
```

Also add `prompts/opening-question.md`: same persona, no `last_answer`, asks the first question about the scenario.
Note in `prompts/README.md` that these prompts were drafted before the hackathon (prior work) and refined here.

## Fixed demo scenario (until the generator arrives)

`server/src/scenarios/cafe.ts`: a fictional neighbourhood café, "Kettle & Crumb", whose owner Maya is being
interviewed by a local paper after a customer posted that she found glass in a pastry; the post has
40,000 views; the health inspector visits tomorrow. Reporter: Walter, "The Riverside Courier", relentless,
agenda "find out whether the café knew about the broken display case before the incident".

## Session protocol over `/ws`

Define the messages in `shared/` (zod schemas used by both sides). Client to server: `start`, binary PCM
frames, `stop`. Server to client: `state` (`listening` / `thinking` / `speaking`), `transcript`
(`{role, text}`), `reporter_line` (`{say, move, flags, quote_used}`), binary PCM 24 kHz audio frames,
`audio_end`, `timing`, `error`.

**Timing is a feature**: for every turn record and send `timing` with ms from the user's speech end
(the `speechEnd` event) to final transcript, to first LLM token or response, to first TTS audio byte, and the total
to first audio. Log one line per turn on the server too. We will show these numbers in the demo.

## Web

Session screen, reached by the Start button (now enabled):
- Big status headline: "Ready." before start, "Live." while running (with the small red `--live` dot), plus a clock.
- The reporter's current question as the headline on the left; the user's last answer on the right
  (stacked on narrow screens).
- Transcript below on white paper. A small timing line under each reporter line (e.g. `1.9 s to voice`).
- One black primary button: "End". Mic capture with an AudioWorklet that downsamples to 16 kHz PCM16.
- Play reporter audio by scheduling PCM chunks on an `AudioContext` (24 kHz) so playback starts on the first
  chunk. When `audio_end` arrives and playback finishes, resume listening.

## Tests and a smoke script

- Unit tests with fake adapters for the session orchestrator: final transcript → LLM → TTS → client
  messages, half-duplex state transitions, timing fields present, invalid LLM JSON retried once.
- `npm run smoke:voice` (`server/scripts/smoke-voice.ts`): no browser and no listening port. It synthesizes
  one spoken answer with ElevenLabs as the "owner" (any voice, PCM 16 kHz output via `output_format=pcm_16000`),
  streams it through the real STT adapter, sends the transcript to the real journalist prompt, and synthesizes
  the reply. It prints the transcript, the reporter JSON and the timings, and writes the reply audio to
  `tmp/smoke-reply.wav` (gitignored). Run it once yourself and include the output in your report.

## Done means

- `npm run check` passes; `npm run smoke:voice` succeeds against the real providers.
- Small logical commits pushed to `origin main`.
- Report: what you built, the smoke output and timings, what you were unsure about.
