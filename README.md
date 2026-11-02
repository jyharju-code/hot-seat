# Hot Seat

Hot Seat gives small business owners a rehearsal before their worst day.

Media training used to be reserved for executives with PR teams. In Hot Seat you
describe your business and a crisis, Muse Wonder builds a fictional scenario, and
AI reporters question you out loud in real time. They interrupt dodges and quote
your own words back. Muse Voice Transcribe listens, Muse Spark plays the reporters
and watches body language through the webcam, and the debrief ends with tomorrow's
front page made by Muse Image. English first, Finnish second.

This repository currently contains only the foundation: the monorepo, the provider
interfaces, the Meta language model adapter, and one start screen. Session logic
arrives in later briefs.

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

In this scaffold only the Meta `Llm` adapter is implemented. The other adapters are
interfaces with TODO stubs that throw `NotImplemented`. One integration test calls
the live Meta API and is skipped unless `MODEL_API_KEY` is set.

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
| Interview plan | Muse Spark (chat) | |
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

## Built during the hackathon

All code in this repo was written from scratch from 26 Oct 2026 by Muse Code,
directed by Juhana Harju, with the briefs in `.muse-briefs/`. Hot Seat is an entry
to the Meta Global AI Developer Hackathon (Indie track, theme "Build for Your World").

## Prior work

Before the hackathon we only measured provider latency and drafted prompts and
voices in a separate private folder; no code from it is in this repo.
