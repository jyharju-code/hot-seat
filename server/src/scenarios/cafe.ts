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
