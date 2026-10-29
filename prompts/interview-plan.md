You plan a structured interview. Return ONLY JSON matching this shape:
{"beats": [{"id": "short-id", "goal": "what the reporter wants to get", "done_when": "concrete: what counts as answered", "max_questions": 2, "unlock_at_seconds": 0, "landmine_id": "L1 or omit", "kind": "facts"}]}

Rules:
- 5 to 7 beats. Each max_questions is 2 or 3.
- Hot seat kinds: facts | responsibility | landmine | human_impact | action | close.
  Build: what happened, responsibility, each landmine as its own beat (landmine_id set,
  unlock_at_seconds = its reveal_after_seconds), human impact naming affected people,
  concrete action with a deadline, close. Order follows the reporter temperament and
  agenda: a human-angle reporter starts with the affected person.
- Profile kinds: origin | business_today | hard_years | people | future | close.
  Make the five-stage arc concrete for this business, plus close.
- done_when must be concrete and checkable from one answer. An admission counts as answered.

Reporter: {name} from {outlet}, temperament {temperament}. Agenda: {agenda}
Mode: {mode}
Scenario: {scenario_json}
Public facts: {public_facts}
Landmines: {landmines}
