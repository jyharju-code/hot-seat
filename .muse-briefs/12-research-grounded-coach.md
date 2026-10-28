# Brief 12: a debrief coach grounded in research

The user likes the debrief and wants it backed by real research on crisis communication and media interviews,
so the coaching is not just a model's opinion. This is a research task first, then a prompt change.

## 1. Research (write `docs/research/crisis-communication.md`)

Find and read real, citable sources. Topics, at least these:
- Situational Crisis Communication Theory (Coombs): crisis types, responsibility attribution, response strategies.
- Image repair theory (Benoit): denial, evasion of responsibility, reducing offensiveness, corrective action,
  mortification.
- "Stealing thunder": disclosing bad news yourself before others do (Arpan and Roskos-Ewoldsen and later work).
  This is directly relevant to our owner-known landmines.
- Apology research: what makes an organisational apology credible, and its legal side.
- Evidence on "no comment", speculation, blame-shifting, and the speed of the first response.
- Media-interview practice: bridging, message discipline, handling hostile questions, the human-impact question.
- Small businesses and local crises if any research exists.

Rules for every source: author, year, title, venue, and a DOI or URL **you actually opened**. If you cannot open
a source, leave it out; never cite from memory. For each source write 2 to 4 sentences: the finding and how it
applies to a spoken interview. Mark findings with weak or mixed evidence as such. Use the web tools you have; if
you have no web access in this run, stop and say so in the report instead of writing the file from memory.

## 2. The coach's knowledge (write `prompts/coach-knowledge.md`)

From the research, write a compact rubric (max about 900 words) the debrief model can apply: what good looks like
on each score (clarity, accountability, composure, message discipline, empathy), the landmine rules in research
terms (proactive disclosure = stealing thunder), and common failure patterns with the better alternative. Each
rule ends with a short source tag like `[Coombs 2007]` that matches an entry in the research file.

## 3. Debrief uses it

- `debrief.md` includes `{coach_knowledge}` and tells the model to judge by it.
- Each `worst_moments` item may carry an optional `principle` field (short name plus source tag, e.g. "Stealing
  thunder [Arpan & Roskos-Ewoldsen 2005]"). The debrief view shows it as a small line under the better answer.
- Keep the debrief prompt lean: the knowledge file is the only addition. Log the prompt size.
- Unit tests: the placeholder is filled, old debriefs without `principle` still render.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report that lists the sources you used.
