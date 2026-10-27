# Brief 01b: finish the scaffold and publish

Brief 01 is almost done: `npm run check` passes. Your sandbox cannot open network ports, so do not start
`npm run dev` or any server; the director verified the dev server outside the sandbox and found the issues below.

## Fixes

1. **Port collision.** The server reads `PORT`, a name that tools and hosts set for the *web* process. When
   `PORT=5173` is in the environment the API server binds 5173 and Vite's `/api` proxy to 3001 gets
   `ECONNREFUSED`. Rename the server's variables to `SERVER_PORT` (default 3001) and `SERVER_HOST`
   (default 127.0.0.1), and make the Vite proxy target read the same `SERVER_PORT` so the two can never drift.
   Update `.env.example`, README and tests. Add a test that `PORT` alone does not change the server port.
2. **Model default.** The current Muse Spark model id is `muse-spark-1.3`; use it as the chat default.
3. **Navigation.** The top bar shows "Providers" as a second nav word but there is no such page. Keep only
   "Home" until there is a second view.

Run `npm run check` after the fixes.

## Publish

1. Commit everything in small logical commits (scaffold, design, fixes). `.env` must not be committed.
2. `gh repo create jyharju-code/hot-seat --public --source . --remote origin --push --description "Hot Seat: a live crisis rehearsal for small business owners. Built with Meta Muse models."`
3. If the network call is blocked in your sandbox, stop after committing and say so in the report.

Finish with a short report: commits made, whether the push succeeded, anything unsure.
