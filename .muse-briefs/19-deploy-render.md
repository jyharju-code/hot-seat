# Brief 19: deploy to Render (free web service), access code, budget caps

Narrow brief. Feature freeze is on: no product changes. The judges need a **live product** at a public HTTPS URL
(the microphone only works over HTTPS). Target: Render free web service, region Virginia (US East), deployed
from this GitHub repo. The server must serve the built web app, the API and `/ws` from **one** port.

Before you start, tag the current head `pre-brief-19` and push the tag.

## 1. One process serves everything in production

- `server`: when `NODE_ENV=production`, serve `web/dist` as static files (Fastify static or a small handler),
  with SPA fallback to `index.html` for unknown non-API GET paths. `/api/*` and `/ws` keep working as now.
- Bind to `0.0.0.0` and use Render's `PORT` env var when it is set (`PORT` wins over `SERVER_PORT`; keep the
  local defaults `127.0.0.1:3001` when neither is set, so local dev is unchanged).
- Root scripts: `build:prod` builds `shared` (if needed) and `web`; `start:prod` starts the server with
  `NODE_ENV=production`. Keep `tsx` at runtime if that is simplest (it is already a dependency path that works).
- `DATA_DIR` default stays `./data`. On Render the disk is ephemeral; that is fine.

## 2. `render.yaml` (Blueprint)

- One `web` service, `runtime: node`, `plan: free`, `region: virginia`, Node 24, `buildCommand`
  `npm ci --include=dev && npm run build:prod`, `startCommand` `npm run start:prod`,
  `healthCheckPath: /api/health`, `autoDeploy: true` from `main`.
- Env vars in the blueprint: `NODE_ENV=production`, `TTS_PROVIDER=browser`, `INTERRUPTS=on`. Secrets declared
  with `sync: false` (the owner types them in the Render dashboard): `MODEL_API_KEY`, `ACCESS_CODE`.
  Do **not** declare ElevenLabs, Soniox or Baseten keys: at runtime only Meta models are called.

## 3. Access code and budget caps (protects the remaining Meta credits)

- If `ACCESS_CODE` is set, every `/api/*` route except `/api/health` and every `/ws` upgrade requires it
  (header `x-access-code` for HTTP, query `?code=` or the first WS message for `/ws`, your choice, but never
  log the code). Wrong or missing code: 401. If `ACCESS_CODE` is unset, nothing changes (local dev, sims).
- Web: a small, calm gate screen before setup ("Enter the access code from the submission page"), stored in
  `localStorage`, sent on every request and on the WS connect. Same visual style as the setup view. Also accept
  `?code=XXXX` in the page URL once (then store it and strip it from the address bar), so a judge link can
  carry the code.
- Caps (config, defaults in parentheses): `MAX_SESSIONS_PER_DAY` (60, server-wide, counts scenario
  generations), `MAX_SESSIONS_PER_IP_PER_HOUR` (6). Over a cap: a friendly message, no model call. In-memory
  counters are fine. Unset or `0` means no cap.

## 4. Reachability check (the geo question)

- `GET /api/health?deep=1`: in addition to the current health, call the Meta Model API `GET /v1/models` with
  the server key and return `{ meta: { status, model_count, ms } }` only (never the key, never the body). This
  call is free and tells us right after the first deploy whether the Meta API answers from Render's region.
  Rate-limit it to once per 30 s (cache the last result).

## 5. Keep-awake (Render free sleeps after 15 min idle)

- `.github/workflows/keep-awake.yml`: on `schedule` every 10 minutes and `workflow_dispatch`, `curl -fsS` the
  URL in repository variable `RENDER_URL` + `/api/health` (no secrets; skip quietly when the variable is unset).

## 6. README

- A short "Deploy" section: Render blueprint, the two secrets, the access code, the caps, `?deep=1`.
- A short "Which parts are Meta models" table if it is not already there: scenario, reporter turns, interrupts,
  interview plan, debrief, front page image (Muse Image), speech to text (Muse Voice Transcribe) are Meta Model
  API calls; the reporter's voice and the news anchor's voice are the browser's built-in speech synthesis (an
  on-device browser feature, not a model call).

## 7. Tests

- Access code: 401 without, 200 with; `/api/health` open; WS upgrade refused without the code; nothing
  enforced when `ACCESS_CODE` is unset.
- Caps: the N+1th session over a cap is refused without a model call.
- Static serving: `GET /` and `GET /some/client/route` return `index.html` in production mode, `/api/presets`
  still returns JSON.
- `PORT` overrides `SERVER_PORT`; host is `0.0.0.0` when `PORT` is set.

Same rules: no listening ports in tests beyond what the existing tests do, never print keys, no elevated
retries. `npm run check`, also run `npm run build:prod` once locally to prove it builds, small commits (include
this brief), push, short report.
