# Brief 16: Meta models only at runtime (browser speech by default)

The organisers' answer on the hackathon Discord (#questions, "Using ElevenLabs for Text-to-Speech", repeated in
"Third party libraries, tools, frameworks"): **every model the project calls at runtime must be a Meta model.
ElevenLabs cannot be used for the voice, even if disclosed. A built-in system or browser voice that is not an AI
model call is fine; the README must say which parts are OS or browser features and which are Meta model calls.**

Today every spoken line (reporter, interruption, radio news flash, evening news anchor) is ElevenLabs. Muse
Voice Transcribe, Muse Spark / Wonder (Meta API), muse-spark-open on Baseten and Muse Image are all Meta models
and stay as they are.

User decision: switch the default to the browser's own speech synthesis. **Keep the ElevenLabs adapter, its
voices and the Soniox configuration in the code, intact and tested, behind a setting.** If the organisers later
allow it, switching back must be one environment variable. Do not delete or rename those structures.

## 1. Setting

- `TTS_PROVIDER` = `browser` (default) | `elevenlabs`. `elevenlabs` requires `ELEVENLABS_API_KEY`; without it
  the server falls back to `browser` and logs why. `SONIOX_API_KEY` and its config stay untouched.
- `/api/health` and the startup log show the active TTS path. In browser mode, label it
  "Text to speech: browser speech synthesis (on-device, not a model call)".

## 2. Server in browser mode

- No TTS calls. The orchestrator keeps the same half-duplex loop: it sends `reporter_line` (and `interrupt`,
  `news_flash`) with the text, then waits for the client's `playback_done` exactly as today, so the next STT
  session still opens only after the reporter has finished speaking.
- Each spoken message carries a voice hint the client can use: `{ role: "reporter" | "radio" | "anchor",
  temperament, gender }`. Extend the shared schemas; old clients and the ElevenLabs path keep working.
- Speculative TTS is skipped in browser mode (no-op, no errors). Turn timing: measure to the moment the server
  sends the line, and add an optional client-reported `speechStartMs` (new client message `speech_started`) so
  the sim and logs still show a real first-sound latency.
- ElevenLabs audio tags (`[sharply]` etc.) are stripped before the browser speaks them; the display already
  strips them. Optionally map a few tags to small rate or pitch changes; keep it simple.
- Add a server-side guard: in browser mode, no code path may call `api.elevenlabs.io`. A unit test proves it
  with a fetch spy over a full fake session (hot seat and profile).

## 3. Client speech

- A small `web/src/audio/browser-speech.ts`: queue, speak, cancel, `onstart` and `onend`, then
  `playback_done` (and `speech_started`). Handle `voiceschanged` (voices load late in Chrome) and a stuck
  `speechSynthesis` (Chrome sometimes never fires `onend` on long text: split into sentences and use a timeout
  per sentence based on its length).
- **Use only on-device voices: `voice.localService === true`.** Chrome's "Google ..." voices are network
  calls to Google; never pick them. English voices only for now.
- Voice choice per role from the local voices, as config, not code paths: distinct voices for relentless,
  precise and human reporters by gender, a calm British voice for the radio and the evening news anchor
  (macOS "Daniel" if present). Prefer "(Enhanced)" or "(Premium)" variants when installed. Use rate and pitch
  to separate temperaments when few voices exist. Fall back to the default voice cleanly.
- An interruption (`interrupt`) cancels nothing the owner says; it speaks the line and then `playback_done`
  as today.
- First speech needs a user gesture in some browsers: the Start button already counts; make sure the first
  `speak()` happens inside or after it.
- A one-line hint in the setup view: "Tip: for the best voices, install an Enhanced English voice in your
  system settings." No error if none is installed.

## 4. Evening news clip in browser mode

- The server still cuts the owner's soundbite from their own recording (not a model call) and returns the
  timeline, but no anchor audio. The endpoint returns the soundbite WAV plus the anchor texts.
- The player speaks the anchor intro and outro with the browser voice and plays the soundbite between them,
  following the timeline. Captions show the anchor lines too.
- "Save clip": browser speech cannot be captured by `MediaRecorder`. In browser mode the saved file contains
  the video, the soundbite audio and the anchor lines as burned-in captions. Say so in one quiet line under the
  button. In ElevenLabs mode it works as today.

## 5. Sim, docs, tests

- The sim works in both modes. In browser mode it treats a reporter line as spoken after a duration estimated
  from its length (about 2.6 words per second) and then sends `playback_done`. The sim's own synthetic owner
  voices are a test tool and may keep using ElevenLabs; mark that clearly in the sim's README section as
  dev-only, never part of the product runtime.
- README: a short "Models at runtime" table listing every runtime call (Muse Voice Transcribe, Muse Spark /
  Wonder, muse-spark-open on Baseten, Muse Image) and what is a browser feature (speech synthesis, audio
  capture, the news player). Note the optional `TTS_PROVIDER=elevenlabs` path as off by default.
- `.env.example`: `TTS_PROVIDER=browser`; ElevenLabs key documented as optional.
- Unit tests: provider selection and fallback, schemas with voice hints, no ElevenLabs fetch in browser mode,
  `playback_done` flow unchanged, news-clip endpoint in browser mode, tag stripping. Existing ElevenLabs tests
  stay green.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
