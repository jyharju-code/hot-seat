# Hot Seat

Hot Seat is a live press-interview rehearsal for small business owners. You
describe your business and a crisis, Muse Wonder builds a fictional scenario, and
an AI reporter questions you out loud in real time. The reporter interrupts
dodges and quotes your own words back.

Two modes: a hot seat crisis interview, and a friendly profile interview for a
happy occasion. One reporter per session, in a 5- or 10-minute session. After
the interview you get a debrief with scores, your best and worst moments (each
worst moment comes with a better line for next time), an interview map,
tomorrow's front page with your photo, and an evening news clip. English only.

The webcam takes one still photo mid-session for the front page and the news
clip. It is not analysed for body language.

## Run it

Requirements: Node 24 and npm.

```bash
cp .env.example .env   # fill in keys you have; all are optional for the scaffold
npm ci
npm run dev
```

One `npm run dev` starts both parts:

- Web: http://127.0.0.1:5173
- Server: http://127.0.0.1:3001 (health check: `GET /api/health`, provider
  status: `GET /api/providers`, no secrets are returned)

The server binds `SERVER_PORT` (default 3001) on `SERVER_HOST` (default
127.0.0.1). It deliberately ignores `PORT`, which tools and hosts set for
the web process. The Vite `/api` proxy reads the same `SERVER_PORT`, so
the two can never drift.

Checks:

```bash
npm run check   # typecheck + lint + test
```

## Deploy

The live demo runs as one Render free web service (region Virginia) deployed
from this repo's `main` branch via the [render.yaml](render.yaml) Blueprint.
One process serves the built web app (`web/dist`), the API and `/ws` from the
single `PORT` Render provides. Local dev is unchanged (`127.0.0.1:3001`).

```bash
npm run build:prod   # builds shared (typecheck) and web
npm run start:prod   # serves web/dist + API + /ws with NODE_ENV=production
```

Render dashboard setup: create a Blueprint from `render.yaml`, then type in
the two secrets it declares (`sync: false`): `MODEL_API_KEY` and
`ACCESS_CODE`. No ElevenLabs, Soniox or Baseten keys are declared: at runtime
only Meta models are called. The disk is ephemeral, so `DATA_DIR` keeps its
`./data` default.

Access code and budget caps (protect the remaining Meta credits):

- When `ACCESS_CODE` is set, every `/api/*` route except `/api/health` and
  every `/ws` upgrade needs it (`x-access-code` header, or `?code=` for the
  socket and media URLs). Wrong or missing code answers 401. The web app
  shows a gate screen first, stores the code in `localStorage`, and also
  accepts `?code=XXXX` in the page URL once (stored, then stripped from the
  address bar), so a judge link can carry the code. When `ACCESS_CODE` is
  unset, nothing is enforced.
- `MAX_SESSIONS_PER_DAY` (default 60, server-wide) and
  `MAX_SESSIONS_PER_IP_PER_HOUR` (default 6) count scenario generations. Over
  a cap the server answers 429 with a friendly message and makes no model
  call. Unset or `0` means no cap. Counters are in memory.
- `GET /api/health?deep=1` adds a free Meta Model API reachability probe
  (`{ meta: { status, model_count, ms } }`, never the key or the body),
  cached for 30 s. It tells us right after the first deploy whether the Meta
  API answers from Render's region.
- Render free sleeps after 15 min idle. The
  [.github/workflows/keep-awake.yml](.github/workflows/keep-awake.yml)
  workflow pings `/api/health` every 10 minutes using the `RENDER_URL`
  repository variable (skips quietly when unset).

## Architecture

TypeScript everywhere, npm workspaces: `server/`, `web/`, `shared/`.

- `server/`: Fastify, with `ws` ready for realtime audio over WebSockets. Config
  comes from environment variables and is validated with Zod at startup.
- `web/`: Vite and React, plain CSS with design tokens, self hosted fonts. No UI kit.
- `shared/`: types used by both sides, including session events and the scenario shape.
- `prompts/`: prompts live as Markdown files and are loaded at runtime, never
  hard coded in TypeScript. See [prompts/README.md](prompts/README.md).

Every AI provider sits behind a small interface in `server/src/providers/`, so any
of them can be swapped without touching session code.

| Port | First adapter | Later |
|---|---|---|
| `Llm` (chat + structured JSON) | Meta Model API (`https://api.meta.ai/v1`, OpenAI compatible; Muse Spark via chat completions, Muse Wonder via the Responses API) | Baseten Muse Spark Open (`https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`) |
| `SpeechToText` (streaming) | Meta Muse Voice Transcribe (`wss://api.meta.ai/v1/asr/realtime`) | Soniox for Finnish |
| `TextToSpeech` | Browser speech synthesis by default (on-device, not a model call); ElevenLabs `eleven_v4` only when `TTS_PROVIDER=elevenlabs` | |
| `ImageGen` (edit a photo) | Muse Image `/v1/images/edits` | |

Every port has a working Meta adapter (`MetaLlm`, `MuseSpeechToText`,
`MetaImageGen`); reporter turns can hedge to Baseten and speech can use
ElevenLabs instead of the browser. Stub implementations are used when the
matching key is missing. One integration test calls the live Meta API and is
skipped unless `MODEL_API_KEY` is set.

Config keys (see `.env.example`): `MODEL_API_KEY`, `ELEVENLABS_API_KEY` (optional),
`SONIOX_API_KEY`, `BASETEN_API_KEY`, `TTS_PROVIDER` (`browser` default, or `elevenlabs`).

## Models at runtime

| Runtime call | What it is |
|---|---|
| Muse Voice Transcribe | Meta model call (speech to text) |
| Muse Spark / Wonder (Meta API) | Meta model calls (reporters, scenarios, debrief) |
| muse-spark-open on Baseten | Meta model call (optional turn provider/hedge) |
| Muse Image | Meta model call (front page and studio images) |
| Speech synthesis (reporter, radio, anchor) | Browser/OS feature (`speechSynthesis`, on-device voices only, not a model call) |
| Audio capture and news player | Browser features (microphone, playback, canvas) |

### Which parts are Meta models

| Product part | Meta Model API call | Not a model call |
|---|---|---|
| Scenario generation | Muse Wonder (structured) | |
| Reporter turns | Muse Spark (chat) | |
| Interrupt decisions | Muse Spark (chat) | |
| Interview plan | Muse Wonder (chat) | |
| Debrief | Muse Wonder (structured) | |
| Front page image | Muse Image | |
| Speech to text | Muse Voice Transcribe | |
| Reporter's voice | | Browser speech synthesis (on-device) |
| News anchor's voice | | Browser speech synthesis (on-device) |

The ElevenLabs adapter, its voices and the Soniox configuration stay in the code behind
`TTS_PROVIDER=elevenlabs` (off by default, requires `ELEVENLABS_API_KEY`). Without that key the
server falls back to `browser` and logs why.

Dev-only: the sim (`npm run sim`) may use ElevenLabs for its synthetic owner voices. That is a
test tool, never part of the product runtime. In browser mode the sim estimates a reporter
line's spoken duration at about 2.6 words per second and then sends `playback_done`. Optional overrides: `SERVER_PORT`
(default 3001), `SERVER_HOST` (default 127.0.0.1), `LLM_CHAT_MODEL`
(default `muse-spark-1.3`), `LLM_STRUCTURED_MODEL` (default
`muse-wonder-1.0`). Never commit `.env`.

## How it works

- Scenario generation: a director prompt (crisis or profile) turns your
  description into a fictional scenario with landmines, one reporter with an
  agenda, and timed escalations.
- Interview plan and state: the model drafts an interview plan of beats; if
  that call fails, a deterministic fallback plan in code takes over
  (`server/src/session/interview-state.ts`). The session tracks each beat with
  a directive (PUSH to stay, MOVE_ON, at most one CALLBACK to a contradiction)
  and never repeats a closed beat: a repeated line is retried once, then
  replaced with a deterministic transition question.
- Turn-taking for hesitant speakers: the reporter's next turn starts
  speculatively after a 450 ms stable partial transcript; the end-of-turn
  silence adapts (longer when the answer looks hesitant) and is capped so the
  turn ends 4 s after the last speech; a late-continuation window still hears
  an owner who resumes mid-reply while browser speech is talking.
- Browser speech watchdog: reporter and anchor voices are on-device speech
  synthesis with a 1.5 s start watchdog (cancel, one retry, then silent
  reading). A failed line stays on screen and the server is told.
- Debrief: the coach judges the transcript against practice guidance grounded
  in crisis communication research (`docs/research/crisis-communication.md`,
  `prompts/coach-knowledge.md`).

## Built with Muse Code

All code in this repo was written from scratch from 26 Oct 2026 by Muse Code,
directed by Juhana Harju, with the briefs in `.muse-briefs/`. Hot Seat is an entry
to the Meta Global AI Developer Hackathon (Indie track, theme "Build for Your World").

## Prior work

Before the hackathon we only measured provider latency and drafted prompts and
voices in a separate private folder; no code from it is in this repo.
