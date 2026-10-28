import {
  nextFrontPageStep,
  type Debrief,
  type FrontPageResult,
  type FrontPageStep,
  type GeneratedScenario,
} from "@hot-seat/shared";

export type HtmlFrontPage = Extract<FrontPageResult, { kind: "html" }>;

export function isHtmlFrontPage(frontPage: FrontPageResult | null | undefined): frontPage is HtmlFrontPage {
  return frontPage?.kind === "html";
}

/** Step a Try again press should start from: the next step down, never the top. */
export function frontPageRetryStep(frontPage: FrontPageResult | null | undefined): FrontPageStep | null {
  if (!frontPage) return "edit_full";
  return nextFrontPageStep(frontPage.step);
}

/** Last-resort HTML page built in the browser from debrief data alone. */
export function buildClientHtmlFrontPage(
  debrief: Debrief,
  scenario: GeneratedScenario,
  date = "",
): HtmlFrontPage {
  const quotes = [debrief.headline_quote, debrief.best_moments[0]?.quote]
    .map((q) => q?.trim())
    .filter((q): q is string => Boolean(q));
  return {
    kind: "html",
    step: "html",
    paperName: scenario.journalists[0]?.outlet ?? "The Local Courier",
    date,
    headline: debrief.front_page.headline,
    subhead: debrief.front_page.subhead,
    companyName: scenario.company.name,
    summary: scenario.crisis.summary,
    keyFacts: scenario.public_facts.slice(0, 5),
    quotes: [...new Set(quotes)],
    photoBase64: null,
    photoMime: null,
    profile: scenario.format === "profile",
  };
}
