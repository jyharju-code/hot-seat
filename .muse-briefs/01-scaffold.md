# Brief 01: project scaffold

You are building **Hot Seat** for the Meta Global AI Developer Hackathon (Indie track, theme "Build for Your World").
You own the whole codebase: create the repo, write the code, test it, commit and publish it.

## The product in one paragraph

Media training used to be reserved for executives with PR teams. Hot Seat gives every small business owner a
rehearsal before their worst day. The user describes their business and a crisis, Muse Wonder builds a fictional
scenario, and AI reporters question them out loud in real time: they interrupt dodges and quote the user's own words
back. Muse Voice Transcribe listens, Muse Spark plays the reporters and watches body language through the webcam,
and the debrief ends with tomorrow's front page made by Muse Image. English first, Finnish second.

## This task: a clean, easy-to-change foundation

Only the foundation. No session logic yet. Quality over quantity: small modules, clear types, easy to change
when we get new ideas.

### Stack

- TypeScript everywhere, Node 24, npm workspaces: `server/`, `web/`, `shared/`.
- `server/`: Fastify + `ws` (realtime audio will run over WebSockets later). Zod for config validation.
- `web/`: Vite + React. No UI kit. Plain CSS with design tokens (see Design). Fonts self-hosted via
  `@fontsource-variable/archivo` and `@fontsource/public-sans` (bundled, never loaded from Google).
- `shared/`: types used by both sides (session events, scenario shape).
- Vitest for tests. One `npm run dev` starts server and web together. `npm run check` = typecheck + lint + test.

### Architecture (ports and adapters)

Every AI provider sits behind a small interface in `server/src/providers/`, so any of them can be swapped:

| Port | First adapter | Later |
|---|---|---|
| `Llm` (chat + structured JSON) | Meta Model API (`https://api.meta.ai/v1`, OpenAI-compatible; Muse Spark via chat completions, Muse Wonder via the Responses API) | Baseten Muse Spark Open (`https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`) |
| `SpeechToText` (streaming) | Meta Muse Voice Transcribe (`wss://api.meta.ai/v1/asr/realtime`) | Soniox for Finnish |
| `TextToSpeech` (streaming) | ElevenLabs `eleven_v4` | |
| `ImageGen` (edit a photo) | Muse Image `/v1/images/edits` | |

In this task: define the interfaces and write the Meta `Llm` adapter only, with one integration test that is skipped
unless `MODEL_API_KEY` is set. Leave the other adapters as interface + `TODO` stub that throws `NotImplemented`.

Other rules:
- All config from environment variables, validated at startup. Ship `.env.example`, never commit `.env`.
  Keys: `MODEL_API_KEY`, `ELEVENLABS_API_KEY`, `SONIOX_API_KEY`, `BASETEN_API_KEY`.
- Prompts live as Markdown files in `prompts/` and are loaded at runtime, never hard-coded in TypeScript.
  Add `prompts/README.md` explaining this. (The actual prompts arrive in the next brief.)
- Endpoints now: `GET /api/health` and `GET /api/providers` (which providers are configured, no secrets).

### Design (apply to `web/`)

One ground colour, black ink, white paper for documents. Heavy condensed headlines. A reporter's question is the
headline, the user's answer sits next to it. The same look everywhere.

Tokens (CSS custom properties in `web/src/styles/tokens.css`):

| Token | Value | Use |
|---|---|---|
| `--ground` | `#EEEAE0` (newsprint) | background everywhere |
| `--ground-dark` | `#E0DACB` | hover, selected item |
| `--ink` | `#111111` | text, buttons, rules |
| `--paper` | `#FFFFFF` | documents, transcript, debrief, inputs |
| `--muted` | `#4A4740` | secondary text on ground |
| `--live` | `#D7261E` | ONLY the live/recording light |
| `--error` | `#8A1C14` | error text |

Typography: headlines Archivo 800 or 900 at width 75 to 85 percent; body Public Sans 400 and 700.

Layout rules:
- Question as headline on the left, answer on the right; stacked on narrow screens.
- Big status headline: "Ready.", "Live." and a clock.
- Top bar: wordmark "hot seat." in Archivo 900 on the left, navigation as plain words on the right, current one underlined.
- Exactly one black primary button per view, text in `--ground`. Other actions are underlined words.
- Lists and documents on white paper without borders. Square corners everywhere.

Never: hero slogans; the same message as eyebrow, headline and intro; decorative rules; 01/02/03 numbering;
letter-spaced capitals; glows or shadows; rounded cards or pill buttons; the Inter font; long dashes in copy;
AI sparkles, robots or brains. Say plainly what the product does.

For this task the web app shows one screen: top bar, big headline "Take the seat.", one sentence saying what Hot Seat
does, and one black button "Start" that is disabled for now. It also shows the result of `/api/providers` as a small
plain list on white paper.

### Repository

1. `git init` with `main` as the default branch.
2. MIT `LICENSE` (copyright Juhana Harju, 2026), `.gitignore` (node, env, OS files), `.editorconfig`.
3. `README.md`: what Hot Seat is and who it is for, how to run it, architecture (the ports table),
   and a section **"Built during the hackathon"** stating that all code in this repo was written from scratch from
   26 Oct 2026 by Muse Code, directed by Juhana Harju, with the briefs in `.muse-briefs/`. Add a short
   **"Prior work"** section: before the hackathon we only measured provider latency and drafted prompts and voices
   in a separate private folder; no code from it is in this repo.
4. GitHub Actions workflow running `npm ci` and `npm run check` on push.
5. Commit with clear messages (small logical commits are fine), then publish:
   `gh repo create jyharju-code/hot-seat --public --source . --remote origin --push`
   with the description "Hot Seat: a live crisis rehearsal for small business owners. Built with Meta Muse models."

### Done means

- `npm ci && npm run check` passes locally.
- `npm run dev` serves the web screen and `/api/health` returns ok.
- The public repo exists on GitHub with the code pushed.
- Finish with a short report: what you built, how to run it, and anything you were unsure about.
