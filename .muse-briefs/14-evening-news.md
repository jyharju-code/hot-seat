# Brief 14: the evening news clip

Product decision from the user: next to tomorrow's front page, the debrief shows a short **evening news clip**:
a fictional local TV news item where an anchor introduces the story, then plays **the owner's own recorded
voice** saying their most damaging line, out of context, then the anchor closes with a dry remark. Hearing your
own voice on the news is the moment that teaches. It works for both modes (hot seat and profile).

Tone: pointed and dry, like a real local news item that picked the worst soundbite. Never mock the person's
voice, accent, appearance or language skills. At most one wry line, in the outro.

## 1. Keep the owner's audio, briefly

- Per session, keep the owner's mic audio (PCM16 16 kHz) in memory with a mapping from stream offset to wall
  time. Do not write the full recording to disk. After the clip is built, keep only the soundbite segment;
  drop the rest when the session is discarded. The debrief view says in one line: "Your recording is used only
  for this clip and is not kept."

## 2. Find the soundbite in the audio

- First check whether Muse Voice Transcribe realtime events carry word or segment timestamps (log one raw
  `transcript` event in a test fixture; never log keys). If they do, use them.
- If not, approximate: for each word index, take the time it first appeared in a partial transcript, map it to
  the audio offset sent at that moment, minus a calibrated ASR lag (constant, default 350 ms, configurable).
  Pad the cut by 250 ms on both sides and snap the edges to the quietest 20 ms frame within 150 ms.
- Unit tests: word-time mapping from a sequence of partials, fuzzy location of the quote in a turn (the debrief
  quote may differ slightly from the transcript), cut boundaries, padding and snapping.

## 3. Debrief adds the news item

The debrief JSON gains:
```json
"news": {
  "soundbite": "the owner's exact words, 4 to 15 words, from one turn, the most damaging out of context",
  "soundbite_turn": 3,
  "channel": "fictional local TV channel name",
  "anchor_intro": "max 35 words, spoken, sets up the story",
  "anchor_outro": "max 20 words, spoken, dry",
  "chyron": "max 8 words",
  "ticker": ["3 short lines"]
}
```
Old debriefs without `news` still load and simply show no clip.

## 4. Build the clip on the server

- Anchor intro and outro with the existing news voice (Daniel, `eleven_v4_turbo`), soundbite from the owner's
  audio (resampled to the same rate), about 400 ms of silence between parts. One WAV plus a timeline:
  `[{part:"intro"|"soundbite"|"outro", startMs, endMs, text}]`.
- Studio image: Muse Image, "a fictional local TV news studio anchor desk, evening, no people, no text, no logos",
  generated once per server start and cached.
- `GET /api/sessions/:sessionId/news-clip`: 202 while building, 200 with `{ audioUrl, timeline, studioImageUrl,
  channel, chyron, ticker, ownerStillUrl }` when ready. Built in parallel with the front page after the debrief.
  If the soundbite cannot be located confidently, build the clip with the quote shown as a caption over the
  owner's still and the anchor reading it ("The owner told us, quote, ..."), and log why.

## 5. The player (web)

- A 16:9 "Evening news" player under the front page. Intro: studio image with a slow zoom, channel bug in a
  corner, ticker scrolling at the bottom. Soundbite: cut to the owner's still (camera still, or the generated
  storefront when there is no camera) with a slow Ken Burns zoom, a lower third with the owner's name or role and
  company, and a subtitle of the soundbite. Outro: back to the studio. All CSS/canvas, no video generation.
- A "Save clip" button records the player (canvas plus audio, `MediaRecorder`, webm) so the user can share it.
- The view shows "Cutting tonight's news." while the clip is being built.

## 6. Tests and sim

- Unit tests: timeline building, endpoint states (202/200/404), old debriefs without `news`, fallback when the
  soundbite is not found.
- Sim `--debrief` polls the news clip too and reports its build time and whether the soundbite was located.

Same rules: no listening ports, never print keys, no elevated retries. `npm run check`, small commits (include this
brief), push, short report.
