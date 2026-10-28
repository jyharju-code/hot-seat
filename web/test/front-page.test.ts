import { describe, expect, it } from "vitest";
import { buildClientHtmlFrontPage, frontPageRetryStep, isHtmlFrontPage } from "../src/front-page.js";
import { studioMode } from "../src/NewsPlayer.js";

const debrief = {
  scores: { clarity: 1, accountability: 1, composure: 1, message_discipline: 1, empathy: 1 },
  verdict: "v",
  best_moments: [{ t: "00:20", quote: "We pulled the pastries at once.", why: "w" }],
  worst_moments: [],
  headline_quote: "We knew nothing about it.",
  front_page: { headline: "HEADLINE", subhead: "Subhead" },
  landmines: [],
  one_thing_to_practice: "p",
};

const scenario = {
  format: "interview" as const,
  duration_minutes: 5 as const,
  fictionalized_from: null,
  company: { name: "Kettle & Crumb", industry: "café", city: "Riverside", size: "6 staff" },
  spokesperson_role: "owner",
  crisis: { headline: "h", summary: "Summary text.", timeline: ["t"], stakes: "s" },
  briefing_for_user: ["b"],
  public_facts: ["fact one", "fact two"],
  landmines: [{ id: "L1", fact: "f", who_knows: "J1", reveal_after_seconds: 1, owner_knows: true }],
  journalists: [
    { id: "J1", name: "Walter", outlet: "The Riverside Courier", temperament: "relentless" as const, voice: "male" as const, agenda: "a", opening_question: "q" },
  ],
  escalations: [],
  good_answer_shape: "g",
};

describe("HTML front page in the browser (brief 15)", () => {
  it("builds an intentional newspaper payload from debrief data", () => {
    const page = buildClientHtmlFrontPage(debrief, scenario, "Friday 30 October 2026");
    expect(isHtmlFrontPage(page)).toBe(true);
    expect(page.paperName).toBe("The Riverside Courier");
    expect(page.headline).toBe("HEADLINE");
    expect(page.subhead).toBe("Subhead");
    expect(page.keyFacts).toEqual(["fact one", "fact two"]);
    expect(page.quotes).toContain("We knew nothing about it.");
    expect(page.photoBase64).toBeNull();
  });

  it("Try again starts from the next step down, never the top", () => {
    expect(frontPageRetryStep({ kind: "image", imageBase64: "x", mime: "image/webp", step: "edit_full" })).toBe("edit_minimal");
    expect(frontPageRetryStep({ kind: "image", imageBase64: "x", mime: "image/webp", step: "edit_minimal" })).toBe("generate_storefront");
    expect(frontPageRetryStep(buildClientHtmlFrontPage(debrief, scenario))).toBeNull();
    expect(frontPageRetryStep(null)).toBe("edit_full");
  });

  it("news studio falls back to plain CSS when there is no studio image", () => {
    expect(studioMode({ studioImageUrl: "/x", studioFallback: false })).toBe("image");
    expect(studioMode({ studioImageUrl: null, studioFallback: true })).toBe("css");
    expect(studioMode({ studioImageUrl: null })).toBe("css");
  });
});
