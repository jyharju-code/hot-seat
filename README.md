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
| `TextToSpeech` (streaming) | ElevenLabs `eleven_v4` | |
| `ImageGen` (edit a photo) | Muse Image `/v1/images/edits` | |

In this scaffold only the Meta `Llm` adapter is implemented. The other adapters are
interfaces with TODO stubs that throw `NotImplemented`. One integration test calls
the live Meta API and is skipped unless `MODEL_API_KEY` is set.

Config keys (see `.env.example`): `MODEL_API_KEY`, `ELEVENLABS_API_KEY`,
`SONIOX_API_KEY`, `BASETEN_API_KEY`. Optional overrides: `SERVER_PORT`
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
