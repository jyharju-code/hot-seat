import { describe, expect, it } from "vitest";
import { clientMessageSchema, generatedScenarioSchema, ownerKnownLandmines, revealedLandmines } from "@hot-seat/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { presets } from "../src/scenarios/presets.js";
import { requireScenario, ScenarioStore } from "../src/scenarios/store.js";
import { voiceFor, voices } from "../src/voices.js";
import { loadPrompt } from "../src/prompts.js";

describe("scenario schema", () => {
  it("accepts a valid fixture", () => {
    expect(generatedScenarioSchema.parse(cafeTestScenario).company.name).toBe("Kettle & Crumb");
  });
  it("rejects missing fields", () => {
    const rest: Record<string, unknown> = { ...cafeTestScenario };
    delete rest.crisis;
    expect(() => generatedScenarioSchema.parse(rest)).toThrow();
    expect(() => generatedScenarioSchema.parse({ ...cafeTestScenario, journalists: [] })).toThrow();
    expect(() => generatedScenarioSchema.parse({ ...cafeTestScenario, format: "town_hall" })).toThrow();
  });
});

describe("landmine reveal filter", () => {
  it("filters by journalist and elapsed time", () => {
    expect(revealedLandmines(cafeTestScenario, "J1", 0)).toHaveLength(0);
    expect(revealedLandmines(cafeTestScenario, "J1", 40).map((m) => m.id)).toEqual(["L1"]);
    expect(revealedLandmines(cafeTestScenario, "J1", 200).map((m) => m.id)).toEqual(["L1", "L2", "L3"]);
    expect(revealedLandmines(cafeTestScenario, "J2", 9999)).toHaveLength(0);
  });
  it("defaults owner_knows to false so stored scenarios still load", () => {
    const raw = JSON.parse(JSON.stringify(cafeTestScenario)) as { landmines: Array<Record<string, unknown>> };
    for (const m of raw.landmines) delete m.owner_knows;
    const parsed = generatedScenarioSchema.parse(raw);
    expect(parsed.landmines.map((m) => m.owner_knows)).toEqual([false, false, false]);
  });
  it("briefing shows only owner-known landmines, never the surprise", () => {
    const known = ownerKnownLandmines(cafeTestScenario);
    expect(known.map((m) => m.id)).toEqual(["L1", "L2"]);
    expect(known.map((m) => m.fact)).not.toContain(cafeTestScenario.landmines[2]!.fact);
    expect(cafeTestScenario.landmines.filter((m) => !m.owner_knows)).toHaveLength(1);
    expect(cafeTestScenario.landmines.map((m) => m.reveal_after_seconds)).toEqual([40, 90, 150]);
    expect(cafeTestScenario.briefing_for_user.length).toBeGreaterThanOrEqual(6);
    expect(cafeTestScenario.briefing_for_user.length).toBeLessThanOrEqual(8);
  });
});

describe("director prompt (brief 11)", () => {
  it("derives temperament from outlet and writes owner-known landmines in second person", async () => {
    const prompt = await loadPrompt("crisis-director.md");
    expect(prompt).toContain("must follow from their outlet");
    expect(prompt).toContain("not\n  default to \"relentless\"");
    expect(prompt).toContain("local paper often leads with the human angle");
    expect(prompt).toContain("second person");
    expect(prompt).toContain("You got an alert");
    expect(prompt).toContain("Never write\n  owner-known facts in the third person");
  });
});

describe("presets and voices", () => {
  it("ships the six presets", () => {
    expect(presets.map((p) => p.id)).toEqual([
      "cafe_food", "review_storm", "ex_employee", "webshop_leak", "contractor_delay", "association",
    ]);
    for (const p of presets) expect(p.description.length).toBeGreaterThan(10);
  });
  it("maps each temperament and gender to its voice", () => {
    expect(voices.relentless.male.voiceId).toBe("9ZbFvrGBxO3uSmsw6wdI");
    expect(voices.relentless.female.voiceId).toBe("EXAVITQu4vr4xnSDxMaL");
    expect(voices.precise.male.voiceId).toBe("NLRQGWzZAJhAXSlAr34B");
    expect(voices.precise.female.voiceId).toBe("Xb7hH8MSUJpSbSDYk0k2");
    expect(voices.human.male.voiceId).toBe("TX3LPaxmHKxFdv7VOQHJ");
    expect(voices.human.female.voiceId).toBe("XrExE9yKIg1WjnnlVkGX");
    expect(voices.relentless.female.name).toBe("Sarah");
    expect(voices.precise.female.name).toBe("Alice");
    expect(voices.human.female.name).toBe("Matilda");
  });
  it("defaults a journalist without voice to male", () => {
    const raw = JSON.parse(JSON.stringify(cafeTestScenario)) as Record<string, unknown>;
    const journalists = raw.journalists as Array<Record<string, unknown>>;
    delete journalists[0]!.voice;
    const parsed = generatedScenarioSchema.parse(raw);
    expect(parsed.journalists[0]!.voice).toBe("male");
    expect(voiceFor(parsed.journalists[0]!.temperament, parsed.journalists[0]!.voice).voiceId).toBe("9ZbFvrGBxO3uSmsw6wdI");
    expect(voiceFor("precise", "female").voiceId).toBe("Xb7hH8MSUJpSbSDYk0k2");
    expect(voiceFor("human", undefined).name).toBe("Liam");
  });
});

describe("scenario store and ws start", () => {
  it("resolves a stored scenario and rejects an unknown scenarioId", () => {
    const store = new ScenarioStore();
    const id = store.add(cafeTestScenario);
    expect(requireScenario(store, id).company.name).toBe("Kettle & Crumb");
    expect(() => requireScenario(store, "no-such-id")).toThrow(/Unknown scenarioId/);
  });
  it("start requires a scenarioId", () => {
    expect(clientMessageSchema.safeParse({ type: "start", scenarioId: "abc" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "start" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "start", scenarioId: "" }).success).toBe(false);
  });
});

describe("/api/scenarios input validation", () => {
  async function appWithGenerator() {
    const store = new ScenarioStore();
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      store,
      generateScenario: async () => cafeTestScenario,
    });
    return { app, store };
  }

  it("GET /api/presets returns the presets", async () => {
    const { app } = await appWithGenerator();
    const res = await app.inject({ method: "GET", url: "/api/presets" });
    expect(res.statusCode).toBe(200);
    expect(res.json().presets).toHaveLength(6);
    await app.close();
  });

  it("rejects too short and too long descriptions", async () => {
    const { app } = await appWithGenerator();
    for (const description of ["short", "x".repeat(601), "", 42]) {
      const res = await app.inject({ method: "POST", url: "/api/scenarios", payload: { description, language: "en" } });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("accepts a valid description, stores it and returns id plus scenario", async () => {
    const { app, store } = await appWithGenerator();
    const res = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: { description: "My café in Leeds. A customer found glass in a croissant.", language: "en" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; scenario: typeof cafeTestScenario };
    expect(body.scenario.company.name).toBe("Kettle & Crumb");
    expect(store.get(body.id)?.crisis.headline).toContain("Glass");
    await app.close();
  });

  it("reports generation failure plainly", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      store: new ScenarioStore(),
      generateScenario: async () => { throw new Error("wonder unavailable"); },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/scenarios",
      payload: { description: "My café in Leeds. A customer found glass in a croissant.", language: "en" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("failed");
    await app.close();
  });
});
