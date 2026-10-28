# Brief 04: speed and voices

Director's browser test of brief 03: Setup, Building and Briefing work, and the generated scenario
("Mouse filmed in Kallio bakery kitchen before morning bake") is grounded and adult. Three problems:

1. Generating a scenario takes 52 to 68 s. Too long for a first-time user.
2. A reporter turn takes 4 to 6 s from the end of the owner's speech to the reporter's voice, of which 1.5 s is
   the deliberate turn-end silence and about 3 s is the LLM.
3. Wonder created a female reporter (Sanna Lehtinen) but every voice is male.

## 1. Voices by temperament and gender

- Add `"voice": "female|male"` to each journalist in the scenario schema and in `crisis-director.md`
  ("voice: matches the reporter's name"). Default `male` if missing (old fixtures).
- `voices.ts` becomes a table keyed by temperament and voice:

| temperament | male | female |
|---|---|---|
| relentless | Walter `9ZbFvrGBxO3uSmsw6wdI` | Sarah `EXAVITQu4vr4xnSDxMaL` |
| precise | Jo `NLRQGWzZAJhAXSlAr34B` | Alice `Xb7hH8MSUJpSbSDYk0k2` |
| human | Liam `TX3LPaxmHKxFdv7VOQHJ` | Matilda `XrExE9yKIg1WjnnlVkGX` |

## 2. Faster reporter turns

a. **Speculative turn:** when the first final segment of a turn arrives, start the journalist LLM call at once,
   during the turn-end silence window. If more speech arrives before the window closes, abort that call
   (AbortController) and start again with the longer answer when the next final arrives. When the window
   closes, use the in-flight or finished result. Never speak a reply generated from a shorter answer than the
   final one. Unit tests with fake STT and a fake LLM that counts calls and aborts.
b. **Open-weight provider for turns:** add a Baseten adapter for the `Llm` port: OpenAI-compatible
   `https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`, header
   `Authorization: Api-Key ${BASETEN_API_KEY}`. It supports `reasoning_effort` like Muse Spark; if it rejects it,
   omit it. Env `TURN_LLM=meta|baseten` (default `meta` until measured). `/api/providers` shows which is used.
c. `npm run smoke:latency`: 6 journalist turns on a fixed scenario and answer, for each provider, printing
   the median and worst time to the complete JSON and the share of valid JSON. Run it and put the table in
   `docs/measurements.md`. If Baseten is at least 30 % faster with all JSON valid, make it the default.

## 3. Faster scenario generation

`npm run smoke:scenario-speed`: generate the `cafe_food` and `contractor_delay` presets with
(a) `muse-wonder-1.0` reasoning `medium` (current), (b) `muse-wonder-1.0` reasoning `low`,
(c) `muse-spark-1.3` reasoning `low`. Record time and whether the JSON validated, write each output to
`tmp/speed/<config>-<preset>.json`, and add the timing table to `docs/measurements.md`. Do not change the
default yet: the director will compare the quality of the outputs and decide.

Make the generation model and reasoning effort env-configurable (`SCENARIO_MODEL`, `SCENARIO_REASONING`).

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical
commits, push to `origin main`, short report with both tables.
