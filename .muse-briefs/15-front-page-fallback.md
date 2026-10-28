# Brief 15: the front page must never fail

Human test, renovation scenario (headline "Family cooking in living room after kitchen remodel runs three months
late"). The debrief worked; the front page failed:

`[front-page] generation failed after 28224ms: Meta Muse Image edits failed: 400 content_policy_violation
"The response was filtered due to the prompt triggering our content management policy." param: prompt`

The UI showed "Tomorrow's front page could not be made this time." and "Try again", which repeats the exact same
request. The front page is the product's best moment; it must always appear.

## 1. Fallback ladder on `content_policy_violation` (and on any 4xx from the image API)

1. Retry the edit with a **minimal prompt**: the newspaper layout, paper name, date, headline and subhead only.
   Drop the crisis summary, key facts and quotes, and any words about people being hurt, sick, children, families,
   accusations or law. Keep the user's photo.
2. If that is filtered too: `/v1/images/generations` with the **storefront** image (no user photo) and the
   minimal prompt.
3. If that fails as well: render the front page **in the browser** from the debrief data (HTML/CSS newspaper,
   same layout, the user's camera still or no photo). It must look intentional, not like an error page.

Log each step: `[front-page] step=<edit_full|edit_minimal|generate_storefront|html> result=<ok|filtered|error>`
plus the prompt length (never the prompt text with personal data at info level). The "Try again" button starts
from the next step down, not from the top.

Apply the same rule to the profile feature page and the news studio image (fall back to a plain CSS studio).

## 2. Lower the filter risk up front

Review `prompts/front-page.md` (and the profile variant) for wording that a safety filter may read as harmful when
combined with a real person's photo: "accused", "victim", "sick", "children", "lawsuit", "scandal" and similar.
Keep the headline and subhead as given (they are the user's own words), but phrase the rest neutrally. Do not
ask the model to depict the user as guilty, upset or in a negative situation; the photo is a neutral portrait.

## 3. Tests

Fake image provider: filtered once → minimal edit succeeds; filtered twice → storefront succeeds; all fail →
the endpoint returns the HTML-fallback payload and the client renders it. "Try again" starts from the next step.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
