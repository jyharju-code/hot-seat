# Brief 05b: the front page must tell the user's story

The director looked at `tmp/front-page.webp` from `smoke:debrief`. It looks like a real local paper: the
masthead, the headline "We Knew Nothing About The Crack", the photo and the simulation notice are excellent.
But the body text invents a different crisis ("a structural crack in the building's rear wall") because the
image prompt only gets the headline, subhead and company name. The front page must be about what happened in
**this** scenario and what the user **said**.

1. Pass the story into `prompts/front-page.md`: add placeholders `{crisis_summary}` (scenario crisis summary),
   `{key_facts}` (3 to 5 short public facts) and `{quotes}` (the debrief's `headline_quote` plus one best-moment
   quote, verbatim, attributed to "the owner"). Instruction lines to add:
   "The body columns report this story: {crisis_summary}"
   "KEY FACTS box: {key_facts}"
   "Quote the owner only with these exact words: {quotes}. Invent no other quotes from the owner."
2. Without a camera still the lead photo shows a stranger. Describe it instead as "a press photograph of the
   storefront of {company_name}, with reporters and microphones outside, people seen from behind": no
   identifiable owner.
3. Update the test for prompt filling; re-run `npm run smoke:debrief` and check that the body text matches the
   café fixture's crisis. Describe what the new image shows in your report.

Same rules. `npm run check`, small commits (include this brief), push, short report.
