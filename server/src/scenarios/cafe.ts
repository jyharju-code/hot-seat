import type { GeneratedScenario } from "@hot-seat/shared";

/** The café in the generated-scenario shape. Test fixture only (Brief 03). */
export const cafeTestScenario: GeneratedScenario = {
  format: "interview",
  fictionalized_from: null,
  company: { name: "Kettle & Crumb", industry: "café", city: "Riverside", size: "6 staff" },
  spokesperson_role: "owner",
  crisis: {
    headline: "Glass in a pastry at Kettle & Crumb",
    summary: "A customer posted that she found glass in a pastry. The post has 40,000 views. The health inspector visits tomorrow.",
    timeline: ["A customer posted about glass in a pastry", "The post reached 40,000 views", "The health inspector visits tomorrow"],
    stakes: "Customers may be hurt and trust in the café is at risk",
  },
  briefing_for_user: [
    "A customer says she found glass in a pastry",
    "The post has 40,000 views",
    "The health inspector visits tomorrow",
    "The café has a glass display case for pastries",
  ],
  public_facts: [
    "A customer posted that she found glass in a pastry at Kettle & Crumb",
    "The post has 40,000 views",
    "The health inspector visits tomorrow",
    "The café has a glass display case for pastries",
  ],
  landmines: [
    { id: "L1", fact: "The display case cracked two days earlier and was taped, not replaced", who_knows: "J1", reveal_after_seconds: 60 },
    { id: "L2", fact: "A second customer messaged about a chipped plate last week", who_knows: "J1", reveal_after_seconds: 180 },
    { id: "L3", fact: "The morning baker noticed the crack and told the shift lead", who_knows: "J1", reveal_after_seconds: 300 },
  ],
  journalists: [
    {
      id: "J1",
      name: "Walter",
      outlet: "The Riverside Courier",
      temperament: "relentless",
      voice: "male",
      agenda: "find out whether the café knew about the broken display case before the incident",
      opening_question: "[impatient] Walter, Riverside Courier. When exactly did that display case break?",
    },
  ],
  escalations: [{ at_seconds: 120, news_flash: "A second post about the café is spreading", gives_journalist: "J1", new_fact: "A second customer has posted" }],
  good_answer_shape: "Acknowledge, say what you did, commit to a next step, do not speculate",
};

/** Fixed demo scenario until the scenario generator arrives (Brief 02). */
export interface ReporterPersona {
  name: string;
  outlet: string;
  temperament: string;
  agenda: string;
  voiceRole: "relentless";
}

export interface DemoScenario {
  id: string;
  title: string;
  businessName: string;
  ownerName: string;
  brief: string;
  publicFacts: string[];
  reporter: ReporterPersona;
}

export const cafeScenario: DemoScenario = {
  id: "kettle-and-crumb-glass",
  title: "Glass in a pastry at Kettle & Crumb",
  businessName: "Kettle & Crumb",
  ownerName: "Maya",
  brief:
    "A customer posted that she found glass in a pastry at the neighbourhood café Kettle & Crumb. " +
    "The post has 40,000 views. The health inspector visits tomorrow.",
  publicFacts: [
    "A customer posted that she found glass in a pastry at Kettle & Crumb",
    "The post has 40,000 views",
    "The health inspector visits tomorrow",
    "The café has a glass display case for pastries",
  ],
  reporter: {
    name: "Walter",
    outlet: "The Riverside Courier",
    temperament: "relentless",
    agenda: "find out whether the café knew about the broken display case before the incident",
    voiceRole: "relentless",
  },
};
