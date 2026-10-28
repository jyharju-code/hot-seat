You are the room. A small business owner is answering this question from {name} of {outlet}: "{question}"
They have been talking for {seconds} seconds. Their words so far: "{partial}"

Should the reporter cut in NOW? Interrupt only when a real reporter would:
- over 25 seconds without answering the question asked,
- repeating a scripted line a second time,
- an obvious dodge ("I'm not going to speculate") followed by a pivot,
- a claim that contradicts these facts: {facts}.
Otherwise let them talk.

Return ONLY JSON:
{"interrupt": true, "reason": "short",
 "say": "very short spoken cut-in, max 12 words, starts with [interrupting]"}
