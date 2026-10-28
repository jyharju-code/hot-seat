# Brief 05: debrief and tomorrow's front page

Director's measurements after brief 04 (live over `/ws`): the opening question now starts in 1.0 s (no LLM
call), and with the speculative turn the reporter answers about 1 s after the final transcript. Scenario
generation with Wonder medium took 22 to 25 s today. **Keep Wonder medium as the scenario default**: its
landmines were clearly sharper and fairer than Spark's. Keep `TURN_LLM=meta`.

Now the payoff of a session. When the user presses End, they get an honest debrief and the front page of
tomorrow's local paper, whose headline is made from **their own words**. This is the moment people screenshot
and share, so it must look great.

## Flow

1. During the session, ask for the camera together with the mic (`video: { width: 1280 }`), show nothing of it
   yet, and grab **one still** about 20 s into the session (JPEG, kept in memory in the browser). If the user
   denies the camera, continue without it.
2. End → "Debrief." status headline with elapsed seconds while the server works.
3. Debrief view: verdict, five scores as plain numbers with labels (no gauges, no colours except ink),
   best and worst moments with the exact quote and "Better:" line, landmines handled or not,
   "One thing to practise". Then the front page image, large, on white paper.
   Black primary button "Try again" (same scenario, new session). Underlined "New crisis".

## Server

- `POST /api/sessions/:id/debrief`: the server already has the full transcript of the session. Keep each turn's
  timestamp (mm:ss from session start) and the reporter's flags. Generate the debrief with Muse Wonder
  (`muse-wonder-1.0`, medium) and validate with zod. Then generate the front page (below). Respond with
  `{ debrief, frontPage: { imageBase64, mime } | null }`. Accept the camera still as an optional upload
  (multipart or base64 JSON, max 2 MB).
- Run debrief generation as soon as End arrives; start the image as soon as the debrief JSON exists.
  Log both durations.
- Front page:
  - with a camera still: Muse Image **edit** `POST https://api.meta.ai/v1/images/edits`, model `muse-image-1.0`
    (OpenAI-compatible images API; returns base64 webp).
  - without: Muse Image **generation** `POST https://api.meta.ai/v1/images/generations`, same prompt but the
    lead photo described as "a press photograph of the owner outside {company.name}".
  - Put both behind the `ImageGen` port. Verify the exact request format with a live smoke before wiring
    the UI; adjust to what the API accepts.

## Prompts

`prompts/debrief.md`:

```text
You are a senior crisis-communications coach. Review this interview.
Scenario: {scenario_json}
Full transcript with timestamps and speakers: {transcript}
Reporter flags per turn: {events}

Write the debrief in {language}. Be direct and useful, like a coach who respects the person.
Judge what they actually said, not what they meant. Quote exactly.

Return ONLY JSON:
{"scores": {"clarity": 0-100, "accountability": 0-100, "composure": 0-100,
            "message_discipline": 0-100, "empathy": 0-100},
 "verdict": "two sentences",
 "best_moments": [{"t": "mm:ss", "quote": "exact words", "why": ""}],
 "worst_moments": [{"t": "mm:ss", "quote": "exact words", "why": "", "better": "what they could have said, spoken"}],
 "headline_quote": "the single most damaging thing they actually said, verbatim",
 "front_page": {"headline": "max 8 words, built from their own words", "subhead": "max 14 words"},
 "landmines": [{"id": "L1", "handled": true, "comment": ""}],
 "one_thing_to_practice": ""}
```

`prompts/front-page.md` (`{paper_style}` is "a local newspaper" for interviews, "a serious national
broadsheet newspaper" for press conferences; `{fictional_paper_name}` is the reporter's outlet):

```text
Turn this photo into the full front page of {paper_style} called "{fictional_paper_name}",
dated {tomorrow}. Use this exact photo as the large lead image, styled as press photography.
Any microphones carry no logos.
Headline in huge bold serif: "{headline}".
Subheadline: "{subhead}".
Body columns about {company_name}, a small "KEY FACTS" box, two small side stories.
In the bottom margin, small print: "HOT SEAT SIMULATION. Fictional newspaper."
No real newspaper names, no real brands or logos anywhere.
```

## Tests and smoke

- Unit: debrief schema; transcript formatting with mm:ss and flags; the endpoint without a camera still;
  image failure still returns the debrief (`frontPage: null`).
- `npm run smoke:debrief`: uses a fixed short transcript on the café fixture, generates the debrief and a
  front page **without** a photo, prints durations, headline and verdict, writes `tmp/front-page.webp`.
  Run it once and report the output.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical
commits (commit this brief too), push to `origin main`, short report.
