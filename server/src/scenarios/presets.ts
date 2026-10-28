import type { ScenarioPreset } from "@hot-seat/shared";

export const presets: ScenarioPreset[] = [
  { id: "cafe_food", label: "Café", description: "Neighbourhood café. A customer posts that they got food poisoning after lunch; the local paper is calling." },
  { id: "review_storm", label: "Restaurant", description: "Family restaurant. A viral video of a rude waiter, 300 one-star reviews overnight, a reporter at the door." },
  { id: "ex_employee", label: "Design agency", description: "Small design agency. A former employee posts that they were not paid for overtime; it is trending locally." },
  { id: "webshop_leak", label: "Web store", description: "Small web store. Customer emails and addresses leaked; customers are getting scam messages." },
  { id: "contractor_delay", label: "Renovation", description: "Local renovation company. A family's kitchen job is three months late and they went to the evening news." },
  { id: "association", label: "Sports club", description: "Sports club for kids. A coach's old social media posts resurface the night before the tournament." },
];
