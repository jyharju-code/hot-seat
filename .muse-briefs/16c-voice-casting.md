# Brief 16c: voice casting for browser speech, and three small fixes

The user installed macOS Enhanced and Premium English voices. `say -v '?'` on the demo machine now lists:
Aaron (Enhanced) en_US, Allison (Enhanced) en_US, Arthur (Enhanced) en_GB, Ava (Enhanced) en_US, Ava (Premium)
en_US, Daniel (Enhanced) en_GB, Evan (Enhanced) en_US, Fiona (Enhanced) en-scotland, Kate (Enhanced) en_GB,
Jamie (Enhanced) en_GB, Jamie (Premium) en_GB, Martha (Enhanced) en_GB, Oliver (Enhanced) en_GB, Serena
(Enhanced) en_GB, Serena (Premium) en_GB, Stephanie (Enhanced) en_GB. Standard local voices in Chrome on the same
machine: Daniel, Samantha, Karen, Moira, Rishi, Tessa, Fred, Ralph, plus Eloquence voices (Eddy, Flo, Reed,
Rocko, Sandy, Shelley, Grandma, Grandpa) and novelty voices (Albert, Bad News, Bahh, Bells, Boing, Bubbles,
Cellos, Good News, Jester, Junior, Kathy, Organ, Superstar, Trinoids, Whisper, Wobble, Zarvox).

## 1. Casting (config in `web/src/audio/browser-speech.ts`)

- Browsers name these voices differently ("Ava (Premium)", "Ava", or with the language in brackets). Match on
  the base name (text before the first " (") and rank Premium > Enhanced > plain within the same base name.
- Cast so every role sounds different, with fallbacks to standard voices:
  - relentless: male Evan, then Arthur, then Daniel; female Ava, then Allison, then Samantha
  - precise: male Oliver, then Arthur, then Daniel; female Serena, then Kate, then Karen
  - human: male Aaron, then Jamie, then Daniel; female Martha, then Stephanie, then Moira
  - radio news flash: Jamie, then Arthur, then Daniel
  - evening news anchor: Daniel, then Oliver (GB)
- Within one session the reporter voice must differ from the radio and anchor voice when an alternative exists.
- **Never** pick a novelty or Eloquence voice, not even as the last fallback: keep a deny list (names above).
  The final fallback is the browser's default English voice.
- A tiny dev-only helper (console or a hidden `?voices` query) that lists which voice each role resolved to,
  so we can check casting on a new machine. No UI change for users.

## 2. Small fixes from the last verification

- Profile ending: the reporter said goodbye twice ("Thank you so much, this has been such a pleasure..." then the
  owner replied, then "Thank you so much. What a lovely ten year story..."). If the last reporter line was
  already a thank-you or goodbye, the final `session_complete` line should be short ("Thank you again.") or
  skipped, and the session ends after it.
- Sim: after `session_complete` the sim still waited for a listening state and reported
  `timeout waiting for listening state` as a failure, which also skipped the debrief. Treat
  `session_complete` as a normal end and run the debrief.
- Unit tests for the casting ranking, deny list and per-session distinct voices.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
