# Brief 08b: interrupt decisions return empty content

Director verified brief 07b on a separate server: the reopen fix works (the whole 35 s ramble is now captured as
one answer), but **no interrupt ever fires**. Every decision fails in the server log:

```
[interrupt] decision failed: Meta Model API chat returned no message content
[interrupt] decision failed: no JSON object in LLM reply
```

Cause: `server/src/interrupt.ts` calls the LLM with `maxTokens: 200`. Muse Spark always reasons, even at
`reasoning_effort: "minimal"`, and reasoning tokens count against `max_tokens`; 200 is used up before any content
is written. (Journalist turns use 2000 and work.)

1. Interrupt decisions: `maxTokens` at least 1500.
2. In the Meta and Baseten LLM adapters: when content is empty, include `finish_reason` and the usage numbers in
   the error ("empty content, finish_reason=length, reasoning_tokens=200") so this is obvious next time.
3. Add a shared constant for the minimum budget of reasoning models and a unit test that every LLM call site
   (turn, speculative turn, interrupt, scenario, debrief) passes at least that budget.

Same rules. `npm run check`, small commits (include this brief), push, short report.
