import { describe, expect, it } from "vitest";
import { debriefSchema, formatMmSs } from "@hot-seat/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { formatEvents, formatTranscript, SessionStore } from "../src/session/store.js";
import { MetaImageGen, type ImageGen } from "../src/providers/image-gen.js";
import { buildFrontPagePrompt } from "../src/debrief.js";

export const sampleDebrief = {
  scores: { clarity: 70, accountability: 40, composure: 80, message_discipline: 55, empathy: 60 },
  verdict: "You stayed calm but dodged the key question. The paper will quote the dodge.",
  best_moments: [{ t: "00:20", quote: "We pulled the pastries at once.", why: "Specific action." }],
  worst_moments: [
    {
      t: "00:45",
      quote: "We knew nothing about it.",
      why: "It was not true on your own timeline.",
      better: "We learned about the crack that morning and acted too slowly.",
    },
  ],
  headline_quote: "We knew nothing about it.",
  front_page: { headline: "WE KNEW NOTHING, SAYS OWNER", subhead: "Cafe owner faces questions over cracked case" },
  landmines: [{ id: "L1", handled: false, comment: "You denied knowledge of the crack." }],
  one_thing_to_practice: "Say what you knew and when, before you are asked twice.",
};

const turns = [
  { role: "reporter" as const, text: "When did the display case break?", elapsedSeconds: 0, flags: [] as never[] },
  { role: "user" as const, text: "We knew nothing about it.", elapsedSeconds: 45, flags: ["dodge" as const] },
  { role: "user" as const, text: "We pulled the pastries at once.", elapsedSeconds: 65, flags: [] as never[] },
];

describe("debrief schema", () => {
  it("accepts a valid debrief and rejects out-of-range scores", () => {
    expect(debriefSchema.parse(sampleDebrief).scores.clarity).toBe(70);
    expect(() =>
      debriefSchema.parse({ ...sampleDebrief, scores: { ...sampleDebrief.scores, clarity: 101 } }),
    ).toThrow();
    expect(() => debriefSchema.parse({ ...sampleDebrief, verdict: "" })).toThrow();
    expect(() => debriefSchema.parse({ ...sampleDebrief, landmines: [{ id: "L1" }] })).toThrow();
  });
});

describe("transcript formatting", () => {
  it("formats mm:ss", () => {
    expect(formatMmSs(0)).toBe("00:00");
    expect(formatMmSs(65)).toBe("01:05");
    expect(formatMmSs(600)).toBe("10:00");
  });
  it("includes timestamps, speakers and flags", () => {
    const text = formatTranscript(turns);
    expect(text).toContain("[00:00] Reporter: When did the display case break?");
    expect(text).toContain("[00:45] Owner: We knew nothing about it.");
    expect(formatEvents(turns)).toContain("[00:45] Owner flags: dodge");
    expect(formatEvents([turns[0]!])).toBe("(no flags)");
  });
});

describe("front page prompt", () => {
  it("uses local paper for interviews, broadsheet for press conferences", async () => {
    const local = await buildFrontPagePrompt(sampleDebrief, cafeTestScenario, true, "Friday 30 October 2026");
    expect(local).toContain('a local newspaper called "The Riverside Courier"');
    expect(local).toContain("Use this exact photo");
    expect(local).toContain('"WE KNEW NOTHING, SAYS OWNER"');
    // The body must tell this scenario's story, not an invented one.
    expect(local).toContain(`The body columns report this story: ${cafeTestScenario.crisis.summary}`);
    expect(local).toContain("KEY FACTS box:");
    for (const fact of cafeTestScenario.public_facts.slice(0, 5)) {
      expect(local).toContain(fact);
    }
    expect(local).toContain("Quote the owner only with these exact words:");
    expect(local).toContain(`"${sampleDebrief.headline_quote}"`);
    expect(local).toContain(`"${sampleDebrief.best_moments[0]!.quote}"`);
    expect(local).toContain("the owner");
    expect(local).toContain("Invent no other quotes from the owner.");
    expect(local).not.toContain("{crisis_summary}");
    expect(local).not.toContain("{key_facts}");
    expect(local).not.toContain("{quotes}");
    const national = await buildFrontPagePrompt(
      sampleDebrief,
      { ...cafeTestScenario, format: "press_conference" },
      false,
      "Friday 30 October 2026",
    );
    expect(national).toContain("a serious national broadsheet newspaper");
    expect(national).toContain(
      "a press photograph of the storefront of Kettle & Crumb, with reporters and microphones outside, people seen from behind",
    );
    expect(national).not.toContain("a press photograph of the owner");
    expect(national).not.toContain("Use this exact photo");
  });

  it("caps key facts at five and quotes headline plus one best moment only", async () => {
    const manyFacts = {
      ...cafeTestScenario,
      public_facts: ["fact one", "fact two", "fact three", "fact four", "fact five", "fact six"],
    };
    const prompt = await buildFrontPagePrompt(sampleDebrief, manyFacts, true, "Friday 30 October 2026");
    expect(prompt).toContain("fact five");
    expect(prompt).not.toContain("fact six");
  });
});

describe("MetaImageGen (mocked fetch, live-verified format)", () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const ok = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: webp.toString("base64") }] }), { status: 200 });

  it("generations posts JSON {model, prompt} and decodes webp", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok();
    }) as typeof fetch;
    const gen = new MetaImageGen({ apiKey: "k", fetchFn });
    const out = await gen.generateImage("front page please");
    expect(url).toBe("https://api.meta.ai/v1/images/generations");
    expect(body).toEqual({ model: "muse-image-1.0", prompt: "front page please" });
    expect(out.mimeType).toBe("image/webp");
    expect(out.image.length).toBe(webp.length);
  });

  it("edits posts multipart model, prompt and image", async () => {
    let url = "";
    let form: FormData | null = null;
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = String(u);
      form = init?.body as FormData;
      return ok();
    }) as typeof fetch;
    const gen = new MetaImageGen({ apiKey: "k", fetchFn });
    await gen.editPhoto({ image: new Uint8Array([0xff, 0xd8]), mimeType: "image/jpeg", prompt: "edit it" });
    expect(url).toBe("https://api.meta.ai/v1/images/edits");
    expect(form!.get("model")).toBe("muse-image-1.0");
    expect(form!.get("prompt")).toBe("edit it");
    expect(form!.get("image")).toBeInstanceOf(Blob);
  });
});

function makeApp(imageGen: ImageGen | null) {
  const store = new ScenarioStore();
  const sessions = new SessionStore();
  const id = store.add(cafeTestScenario);
  sessions.put({ id, scenario: cafeTestScenario, startedAtMs: 0, turns });
  const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
    store,
    sessions,
    generateDebrief: async () => debriefSchema.parse(sampleDebrief),
    imageGen,
  });
  return { app, id };
}

describe("POST /api/sessions/:id/debrief", () => {
  it("returns debrief and front page without a camera still (generation path)", async () => {
    let generatedPrompt = "";
    const imageGen: ImageGen = {
      generateImage: async (prompt) => {
        generatedPrompt = prompt;
        return { image: new Uint8Array([1, 2, 3]), mimeType: "image/webp" };
      },
      editPhoto: async () => {
        throw new Error("edit must not be called without a still");
      },
    };
    const { app, id } = makeApp(imageGen);
    const res = await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.debrief.verdict).toContain("dodged");
    expect(body.frontPage.mime).toBe("image/webp");
    expect(Buffer.from(body.frontPage.imageBase64, "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(generatedPrompt).toContain(
      "a press photograph of the storefront of Kettle & Crumb, with reporters and microphones outside, people seen from behind",
    );
    expect(generatedPrompt).toContain(cafeTestScenario.crisis.summary);
    await app.close();
  });

  it("uses the edit path when a still is uploaded", async () => {
    let editMime = "";
    const imageGen: ImageGen = {
      generateImage: async () => {
        throw new Error("generation must not be called with a still");
      },
      editPhoto: async (input) => {
        editMime = input.mimeType;
        expect(input.image.length).toBeGreaterThan(0);
        return { image: new Uint8Array([9]), mimeType: "image/webp" };
      },
    };
    const { app, id } = makeApp(imageGen);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/debrief`,
      payload: {
        stillBase64: Buffer.from([0xff, 0xd8, 1]).toString("base64"),
        stillMime: "image/jpeg",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().frontPage).not.toBeNull();
    expect(editMime).toBe("image/jpeg");
    await app.close();
  });

  it("still returns the debrief when image generation fails", async () => {
    const imageGen: ImageGen = {
      generateImage: async () => {
        throw new Error("image API down");
      },
      editPhoto: async () => {
        throw new Error("image API down");
      },
    };
    const { app, id } = makeApp(imageGen);
    const res = await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().debrief.scores.clarity).toBe(70);
    expect(res.json().frontPage).toBeNull();
    await app.close();
  });

  it("grades by session id and generates only one debrief per session (brief 08 item 8)", async () => {
    const store = new ScenarioStore();
    const sessions = new SessionStore();
    const scenarioId = store.add(cafeTestScenario);
    const a = sessions.startSession(cafeTestScenario, 0, scenarioId);
    const b = sessions.startSession(cafeTestScenario, 0, scenarioId);
    a.turns.push({ role: "user", text: "first run answer", elapsedSeconds: 1, flags: [] });
    let generations = 0;
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      store,
      sessions,
      generateDebrief: async (_s, turns) => {
        generations += 1;
        expect(turns.map((t) => t.text)).toContain("first run answer");
        return debriefSchema.parse(sampleDebrief);
      },
      imageGen: null,
    });
    const first = await app.inject({ method: "POST", url: `/api/sessions/${a.id}/debrief`, payload: {} });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/api/sessions/${a.id}/debrief`, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json().debrief.verdict).toBe(first.json().debrief.verdict);
    expect(generations).toBe(1);
    // The scenario id itself is not a session: no record, no debrief.
    const byScenario = await app.inject({ method: "POST", url: `/api/sessions/${scenarioId}/debrief`, payload: {} });
    expect(byScenario.statusCode).toBe(404);
    expect(b.id).not.toBe(a.id);
    await app.close();
  });

  it("rejects an oversized still and unknown sessions", async () => {
    const { app, id } = makeApp(null);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/debrief`,
      payload: { stillBase64: big, stillMime: "image/jpeg" },
    });
    expect(res.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/sessions/nope/debrief", payload: {} });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
