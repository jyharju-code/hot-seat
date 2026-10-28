import type { ScenarioPreset } from "@hot-seat/shared";

export const presets: ScenarioPreset[] = [
  { id: "cafe_food", label: "Café", description: "Neighbourhood café. A customer posts that they got food poisoning after lunch; the local paper is calling." },
  { id: "review_storm", label: "Restaurant", description: "Family restaurant. A viral video of a rude waiter, 300 one-star reviews overnight, a reporter at the door." },
  { id: "ex_employee", label: "Design agency", description: "Small design agency. A former employee posts that they were not paid for overtime; it is trending locally." },
  { id: "webshop_leak", label: "Web store", description: "Small web store. Customer emails and addresses leaked; customers are getting scam messages." },
  { id: "contractor_delay", label: "Renovation", description: "Local renovation company. A family's kitchen job is three months late and they went to the evening news." },
  { id: "association", label: "Sports club", description: "Sports club for kids. A coach's old social media posts resurface the night before the tournament." },
];

export const profilePresets: ScenarioPreset[] = [
  { id: "profile_cafe_anniversary", label: "Café anniversary", mode: "profile", description: "Neighbourhood café celebrating its tenth anniversary; the local paper wants a warm feature on the owner." },
  { id: "profile_design_award", label: "Design award", mode: "profile", description: "Small design studio that just won an award; a business magazine wants a profile of the founder." },
  { id: "profile_renovation_expansion", label: "Second town", mode: "profile", description: "Local renovation company expanding to a second town; the paper wants the owner's story." },
  { id: "profile_restaurant_handover", label: "Family handover", mode: "profile", description: "Family restaurant handing over to the next generation; the paper wants a feature on both owners." },
  { id: "profile_webstore_entrepreneur", label: "Entrepreneur of the year", mode: "profile", description: "Web store founder named entrepreneur of the year; a magazine wants a warm founder profile." },
  { id: "profile_club_record", label: "Record season", mode: "profile", description: "Sports club celebrating a record season; the local paper wants a feature on the chair and the club." },
];
