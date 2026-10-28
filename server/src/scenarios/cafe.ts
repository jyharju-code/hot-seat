import type { GeneratedScenario } from "@hot-seat/shared";

/** The café in the generated-scenario shape. Test fixture only (Brief 03). */
export const cafeTestScenario: GeneratedScenario = {
  format: "interview",
  duration_minutes: 5,
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
    "On Tuesday at about 09:40, customer Aino Korpi says she found a shard of glass in a cinnamon bun she bought at Kettle & Crumb",
    "Her post about it was shared the same morning and has reached 40,000 views by Wednesday lunchtime",
    "Pastries were pulled from sale on Tuesday at 11:15, and the glass display case was taken out of use that afternoon",
    "The café stayed open for drinks only on Wednesday, and 2 of the 6 staff were sent home",
    "The health inspector visits on Thursday at 10:00 and expects the café's own account of what happened",
    "It is still unknown where the shard came from, and no other customer has reported finding glass so far",
    "Regulars are upset in the post's comments and outside the shop, and The Riverside Courier is covering the story",
  ],
  public_facts: [
    "A customer posted that she found glass in a pastry at Kettle & Crumb",
    "The post has 40,000 views",
    "The health inspector visits tomorrow",
    "The café has a glass display case for pastries",
  ],
  landmines: [
    { id: "L1", fact: "The display case cracked two days earlier and was taped, not replaced", who_knows: "J1", reveal_after_seconds: 40, owner_knows: true },
    { id: "L2", fact: "A second customer messaged about a chipped plate last week and the message was never answered", who_knows: "J1", reveal_after_seconds: 90, owner_knows: true },
    { id: "L3", fact: "The morning baker noticed the crack and told the shift lead, who decided not to tell the owner", who_knows: "J1", reveal_after_seconds: 150, owner_knows: false },
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

/** Friendly profile fixture (Brief 13). Test fixture only. */
export const cafeProfileScenario: GeneratedScenario = {
  format: "profile",
  duration_minutes: 5,
  fictionalized_from: null,
  company: { name: "Kettle & Crumb", industry: "café", city: "Riverside", size: "6 staff" },
  spokesperson_role: "owner",
  crisis: {
    headline: "Ten years of Kettle & Crumb",
    summary: "The neighbourhood café reaches its tenth anniversary and the local paper is writing a warm feature on the owner and the café.",
    timeline: ["The café opened ten years ago", "It survived two hard winters", "The anniversary party is next week"],
    stakes: "A careless quote about people or money could become the headline of an otherwise warm feature",
  },
  briefing_for_user: [
    "Kettle & Crumb opened ten years ago this month and the anniversary party is next week",
    "The Riverside Courier is writing a warm feature about you and the café",
    "You started the café after leaving a bakery job you loved",
    "The café now employs 6 staff and is known for its cinnamon buns",
    "The last two winters were quieter, and this spring has been the busiest yet",
    "Regulars have been coming since the first year and several will be at the party",
    "You hope to open a second small counter at the market hall next year",
  ],
  public_facts: [
    "Kettle & Crumb is ten years old this month",
    "The café employs 6 staff",
    "The anniversary party is next week",
    "The café is known for its cinnamon buns",
  ],
  landmines: [
    { id: "L1", fact: "You fell out with your first partner over money and you still think he nearly killed this place", who_knows: "none", reveal_after_seconds: 9999, owner_knows: true },
    { id: "L2", fact: "You quietly blame your flour supplier for the bad winter and have never told them", who_knows: "none", reveal_after_seconds: 9999, owner_knows: true },
    { id: "L3", fact: "You are proud that you once cut corners on the old oven checks to save money", who_knows: "none", reveal_after_seconds: 9999, owner_knows: true },
  ],
  journalists: [
    {
      id: "J1",
      name: "Matilda",
      outlet: "The Riverside Courier",
      temperament: "human",
      voice: "female",
      agenda: "write a warm anniversary feature and draw out the candid story behind the café",
      opening_question: "[warmly] Matilda, from the Courier. Ten years! Take me back to the very first morning you opened.",
    },
  ],
  escalations: [],
  good_answer_shape: "Tell the story proudly and warmly, keep other people's business private, name no blame, speculate about nobody",
};
