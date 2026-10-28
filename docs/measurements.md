# Measurements

Brief 04, measured 2026-10-28 on this machine with the real provider APIs.
No listening ports were opened and no keys are recorded here.

## Reporter turn latency (`npm run smoke:latency`)

Six journalist turns per provider on the fixed café scenario
(`cafeTestScenario`) and a fixed owner answer, through `JournalistBrain`
(complete JSON, not streaming). Time is from the call to the complete,
validated reporter JSON.

| provider | model | median (ms) | worst (ms) | valid JSON |
|---|---|---|---|---|
| meta | muse-spark-1.3 | 2033 | 3171 | 100% (6/6) |
| baseten | meta-models/muse-spark-open-1026 | 1732 | 2092 | 100% (6/6) |

Baseten was 14.8 % faster on the median with all JSON valid.
That is below the 30 % threshold in the brief, so the default stays
`TURN_LLM=meta`. Set `TURN_LLM=baseten` to use Baseten for reporter turns.
`/api/providers` shows which turn provider is in use.

Note: in a live session the speculative turn starts the LLM on the first
final STT segment, during the turn-end silence window, so much of this
latency is hidden behind the 1.5 s silence before the reply is spoken.

## Scenario generation speed (`npm run smoke:scenario-speed`)

Each configuration generated the `cafe_food` and `contractor_delay`
presets. Raw outputs are in `tmp/speed/<config>-<preset>.json` for the
director to compare quality. The default was not changed.

| config | model | reasoning | preset | time (s) | valid JSON |
|---|---|---|---|---|---|
| wonder-medium | muse-wonder-1.0 | medium | cafe_food | 24.4 | yes |
| wonder-medium | muse-wonder-1.0 | medium | contractor_delay | 22.2 | yes |
| wonder-low | muse-wonder-1.0 | low | cafe_food | 25.5 | yes |
| wonder-low | muse-wonder-1.0 | low | contractor_delay | 36.6 | yes |
| spark-low | muse-spark-1.3 | low | cafe_food | 9.6 | no |
| spark-low | muse-spark-1.3 | low | contractor_delay | 14.1 | yes |

Observations:

- Wonder with reasoning `low` was not faster than `medium` in this run
  (25.5 s and 36.6 s against 24.4 s and 22.2 s). One run per cell, so
  treat this as noise until repeated.
- Spark with reasoning `low` was much faster (9.6 s and 14.1 s), but one
  of its two outputs failed schema validation (a missing
  `spokesperson_role` in `cafe_food`).
- Generation stays on `SCENARIO_MODEL=muse-wonder-1.0` with
  `SCENARIO_REASONING=medium` until the director compares the written
  outputs in `tmp/speed/` and decides.
