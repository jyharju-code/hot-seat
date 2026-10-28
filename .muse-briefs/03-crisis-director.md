# Brief 03: the Crisis Director

Human test of the voice loop: it works and the reporter is sharp ("pretty damn fierce"), but the fixed café
scenario is "fine for practice, childish for production". The user must rehearse **their own** business and
**their own** crisis. Muse Wonder builds that scenario. This is the heart of the product's Impact story.

(Also commit `.muse-briefs/02d-audio-crackle.md`; your last run was cut off before committing it.)

## Flow

1. **Setup view** (from Start): one textarea, "Your business and what went wrong", placeholder
   "My café in Leeds. A customer says she found glass in a croissant and the post is everywhere."
   Under it the presets as plain underlined words that fill the textarea. One black button "Build my scenario".
2. **Building:** status headline "Building." with elapsed seconds. Wonder may take 20 to 60 s; that is fine,
   but the screen must show it is working. Show an error plainly if it fails, with "Try again".
3. **Briefing view:** on white paper: company name and city, crisis headline, the `briefing_for_user` bullets,
   and who is coming: reporter name and outlet. One black button "Take the seat." starts the live session.
   An underlined "Change the story" goes back to Setup.
4. **Session:** as now, but driven by the generated scenario.

## Server

- `POST /api/scenarios` `{ description: string, language: "en" }` → generates with Muse Wonder
  (`muse-wonder-1.0`, Responses API, the structured method of the `Llm` port), validates with zod, stores it in
  an in-memory map with an id, returns `{ id, scenario }`. `GET /api/presets` returns the presets below.
  Validate input length (10 to 600 chars). Log generation time.
- The `/ws` `start` message gets `scenarioId`. Unknown id → `error`. Keep the café as a test fixture only.
- **Opening question:** use the scenario's `opening_question` directly (no extra LLM call: faster start).
- **Voices by temperament** in `voices.ts`: `relentless` Walter `9ZbFvrGBxO3uSmsw6wdI`, `precise` Jo
  `NLRQGWzZAJhAXSlAr34B`, `human` Liam `TX3LPaxmHKxFdv7VOQHJ`.
- **Landmines:** the journalist prompt gets `{landmines_known_to_you}`: the landmines whose `who_knows` is this
  journalist and whose `reveal_after_seconds` has passed since the session started. Add one line to
  `journalist-turn.md`: "Use a landmine when it fits naturally: confront them with it, do not just recite it."
- Only the `interview` format is used in this brief: if Wonder returns `press_conference`, use the first
  journalist. Multiple reporters come in a later brief. Escalations: store them, not used yet.

## Prompt

Create `prompts/crisis-director.md` with exactly this text (placeholders `{language}` and `{spoken_style}`;
the user's description is passed as the user message, not inside the system prompt):

```text
You are the Crisis Director of Hot Seat, a crisis rehearsal room. Hot Seat gives small business
owners and other leaders without a PR team a realistic rehearsal before their worst day.
The user describes their business and a crisis in a few words. Build a realistic, tense,
FICTIONAL scenario that the user will face as the spokesperson, out loud and in real time.

Pick the format that fits the business:
- "interview": one-on-one with a local reporter (default for small businesses: cafés, shops,
  salons, small web stores, local service companies, associations),
- "press_conference": several reporters at once (larger companies, public interest cases).

Hard rules:
- Everything is fictional. If the user names a real company, person or media outlet, create a
  fictional stand-in with a different name and say so in "fictionalized_from". Never put words in
  the mouth of a real person. All media outlets are invented.
- The crisis must be plausible, specific and survivable: there is a good way to handle it.
  Scale it to the business: a café faces a local paper and a social media storm, not the BBC.
- Make it feel like a real small business on a bad day: concrete names, times, amounts, places,
  the messy details owners actually deal with. Adult and grounded, never cartoonish.
- Business and organizational crises only. Never political, electoral, military or war-related
  scenarios, and no medical or mental-health advice. If the user asks for one, pick the closest
  business crisis instead.
- Plant 3 landmines: facts the reporters know (or will learn mid-conversation) that the
  spokesperson has not been told. Each must be fair: a well-prepared owner could handle it.
- Reporters: 1 for "interview", 3 for "press_conference", with different agendas and temperaments
  (relentless, precise, human angle). In an interview the single reporter mixes all three.
- Write in {language}. Names, places and outlets fit the setting.

Return ONLY JSON matching this schema:
{
  "format": "interview|press_conference",
  "fictionalized_from": "string or null",
  "company": {"name": "", "industry": "", "city": "", "size": ""},
  "spokesperson_role": "e.g. owner, CEO, chair",
  "crisis": {"headline": "", "summary": "3 sentences", "timeline": ["..."], "stakes": "who is hurt and how"},
  "briefing_for_user": ["4 to 6 short bullet points: what the user knows walking in"],
  "public_facts": ["..."],
  "landmines": [{"id": "L1", "fact": "", "who_knows": "journalist id", "reveal_after_seconds": 60}],
  "journalists": [{
    "id": "J1", "name": "", "outlet": "fictional", "temperament": "relentless|precise|human",
    "agenda": "what story they want",
    "opening_question": "spoken, follows the spoken style rules"
  }],
  "escalations": [{"at_seconds": 120, "news_flash": "one line: a new post, review, call or headline shown on screen",
                   "gives_journalist": "J1", "new_fact": ""}],
  "good_answer_shape": "what a strong response does: acknowledge, act, commit, without speculating"
}

{spoken_style}
```

## Presets (`server/src/scenarios/presets.ts`)

| id | label | description |
|---|---|---|
| `cafe_food` | Café | Neighbourhood café. A customer posts that they got food poisoning after lunch; the local paper is calling. |
| `review_storm` | Restaurant | Family restaurant. A viral video of a rude waiter, 300 one-star reviews overnight, a reporter at the door. |
| `ex_employee` | Design agency | Small design agency. A former employee posts that they were not paid for overtime; it is trending locally. |
| `webshop_leak` | Web store | Small web store. Customer emails and addresses leaked; customers are getting scam messages. |
| `contractor_delay` | Renovation | Local renovation company. A family's kitchen job is three months late and they went to the evening news. |
| `association` | Sports club | Sports club for kids. A coach's old social media posts resurface the night before the tournament. |

## Tests and smoke

- Unit: schema validation (valid fixture passes, missing fields fail), landmine reveal filter by time and
  journalist, `/api/scenarios` input validation, `start` with unknown `scenarioId`.
- `npm run smoke:scenario`: generates the `webshop_leak` preset with real Wonder, prints the generation time,
  company, headline, briefing and opening question, and writes the JSON to `tmp/scenario.json`. Run it and
  include the output in your report.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small logical
commits, push to `origin main`, short report.
