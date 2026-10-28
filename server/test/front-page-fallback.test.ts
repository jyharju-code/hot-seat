import { describe, expect, it } from "vitest";
import { debriefSchema, nextFrontPageStep } from "@hot-seat/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { cafeProfileScenario, cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionStore } from "../src/session/store.js";
import type { ImageGen } from "../src/providers/image-gen.js";
import { buildMinimalFrontPagePrompt, generateFrontPage } from "../src/debrief.js";

const sampleDebrief = {
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
  landmines: [{ id: "L1", status: "raised_and_fumbled" as const, comment: "You denied knowledge of the crack." }],
  one_thing_to_practice: "Say what you knew and when, before you are asked twice.",
};

const filtered = () =>
  new Error(
    'Meta Muse Image edits failed: 400 content_policy_violation "The response was filtered due to the prompt triggering our content management policy." param: prompt',
  );

const still = { image: new Uint8Array([0xff, 0xd8, 1]), mimeType: "image/jpeg" };
const okImage = { image: new Uint8Array([1, 2, 3]), mimeType: "image/webp" };

function fakeGen(script: { edits: Array<"filtered" | "ok">; gens: Array<"filtered" | "ok"> }) {
  const calls: Array<{ kind: "edit" | "generate"; prompt: string }> = [];
  let ei = 0;
  let gi = 0;
  const gen: ImageGen = {
    editPhoto: async (input) => {
      calls.push({ kind: "edit", prompt: input.prompt });
      if (script.edits[ei++] === "filtered") throw filtered();
      return okImage;
    },
    generateImage: async (prompt) => {
      calls.push({ kind: "generate", prompt });
      if (script.gens[gi++] === "filtered") throw filtered();
      return okImage;
    },
  };
  return { gen, calls };
}

describe("front page fallback ladder (brief 15)", () => {
  it("next step moves down the ladder and ends at html", () => {
    expect(nextFrontPageStep("edit_full")).toBe("edit_minimal");
    expect(nextFrontPageStep("edit_minimal")).toBe("generate_storefront");
    expect(nextFrontPageStep("generate_storefront")).toBe("html");
    expect(nextFrontPageStep("html")).toBeNull();
  });

  it("filtered once: minimal edit succeeds and drops crisis text, facts and quotes", async () => {
    const { gen, calls } = fakeGen({ edits: ["filtered", "ok"], gens: [] });
    const logs: string[] = [];
    const out = await generateFrontPage(gen, debriefSchema.parse(sampleDebrief), cafeTestScenario, still, {
      log: (l) => logs.push(l),
    });
    expect(calls.map((c) => c.kind)).toEqual(["edit", "edit"]);
    expect(out.step).toBe("edit_minimal");
    expect(out.frontPage.kind).toBe("image");
    expect(out.nextStep).toBe("generate_storefront");
    const minimal = calls[1]!.prompt;
    expect(minimal).toContain(sampleDebrief.front_page.headline);
    expect(minimal).toContain(sampleDebrief.front_page.subhead);
    expect(minimal).not.toContain(cafeTestScenario.crisis.summary);
    expect(minimal).not.toContain(cafeTestScenario.public_facts[0]!);
    expect(minimal).not.toContain(sampleDebrief.headline_quote);
    expect(logs.some((l) => l.startsWith("[front-page] step=edit_full result=filtered"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[front-page] step=edit_minimal result=ok"))).toBe(true);
    expect(logs.every((l) => !l.includes(cafeTestScenario.crisis.summary))).toBe(true);
  });

  it("filtered twice: storefront generation succeeds without the user photo", async () => {
    const { gen, calls } = fakeGen({ edits: ["filtered", "filtered"], gens: ["ok"] });
    const out = await generateFrontPage(gen, debriefSchema.parse(sampleDebrief), cafeTestScenario, still, {
      log: () => undefined,
    });
    expect(calls.map((c) => c.kind)).toEqual(["edit", "edit", "generate"]);
    expect(out.step).toBe("generate_storefront");
    expect(calls[2]!.prompt).toContain("storefront");
    expect(calls[2]!.prompt).not.toContain(cafeTestScenario.crisis.summary);
  });

  it("all image steps fail: returns the HTML fallback payload, never throws", async () => {
    const { gen, calls } = fakeGen({ edits: ["filtered", "filtered"], gens: ["filtered"] });
    const logs: string[] = [];
    const out = await generateFrontPage(gen, debriefSchema.parse(sampleDebrief), cafeTestScenario, still, {
      log: (l) => logs.push(l),
    });
    expect(calls).toHaveLength(3);
    expect(out.step).toBe("html");
    expect(out.nextStep).toBeNull();
    if (out.frontPage.kind !== "html") throw new Error("expected html front page");
    expect(out.frontPage.headline).toBe(sampleDebrief.front_page.headline);
    expect(out.frontPage.subhead).toBe(sampleDebrief.front_page.subhead);
    expect(out.frontPage.paperName).toBe("The Riverside Courier");
    expect(out.frontPage.keyFacts.length).toBeGreaterThan(0);
    expect(out.frontPage.photoBase64).toBe(Buffer.from(still.image).toString("base64"));
    expect(logs.some((l) => l.startsWith("[front-page] step=html result=ok"))).toBe(true);
  });

  it("startStep skips earlier steps (Try again starts from the next step down)", async () => {
    const { gen, calls } = fakeGen({ edits: ["ok"], gens: ["ok"] });
    const out = await generateFrontPage(gen, debriefSchema.parse(sampleDebrief), cafeTestScenario, still, {
      startStep: "generate_storefront",
      log: () => undefined,
    });
    expect(calls.map((c) => c.kind)).toEqual(["generate"]);
    expect(out.step).toBe("generate_storefront");
  });

  it("any 4xx (not only content_policy_violation) moves to the minimal edit", async () => {
    let edits = 0;
    const gen: ImageGen = {
      editPhoto: async () => {
        edits += 1;
        if (edits === 1) throw new Error("Meta Muse Image edits failed: 403 forbidden");
        return okImage;
      },
      generateImage: async () => okImage,
    };
    const logs: string[] = [];
    const out = await generateFrontPage(gen, debriefSchema.parse(sampleDebrief), cafeTestScenario, still, {
      log: (l) => logs.push(l),
    });
    expect(out.step).toBe("edit_minimal");
    expect(logs[0]).toContain("result=filtered");
  });

  it("profile feature page uses the same ladder with a friendly minimal prompt", async () => {
    const { gen, calls } = fakeGen({ edits: ["filtered", "ok"], gens: [] });
    const profileDebrief = { ...sampleDebrief, front_page: { headline: "TEN YEARS IN", subhead: "Owner looks back" } };
    const out = await generateFrontPage(gen, debriefSchema.parse(profileDebrief), cafeProfileScenario, still, {
      log: () => undefined,
    });
    expect(out.step).toBe("edit_minimal");
    expect(calls[1]!.prompt).toContain("friendly local newspaper feature page");
    expect(calls[1]!.prompt).not.toContain(cafeProfileScenario.crisis.summary);
  });

  it("minimal prompt builder keeps headline and subhead only from the story", async () => {
    const p = await buildMinimalFrontPagePrompt(
      debriefSchema.parse(sampleDebrief),
      cafeTestScenario,
      "photo",
      "Friday 30 October 2026",
    );
    expect(p).toContain("The Riverside Courier");
    expect(p).toContain("Friday 30 October 2026");
    expect(p).not.toMatch(/accused|victim|sick|children|lawsuit|scandal/i);
  });
});

function makeApp(imageGen: ImageGen | null) {
  const store = new ScenarioStore();
  const sessions = new SessionStore();
  const id = store.add(cafeTestScenario);
  sessions.put({
    id,
    scenario: cafeTestScenario,
    startedAtMs: 0,
    turns: [{ role: "user" as const, text: "We knew nothing about it.", elapsedSeconds: 45, flags: [] as never[] }],
  });
  const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
    store,
    sessions,
    generateDebrief: async () => debriefSchema.parse(sampleDebrief),
    imageGen,
  });
  return { app, id };
}

async function pollFrontPage(app: ReturnType<typeof buildApp>, id: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}/front-page` });
    if (res.statusCode !== 202) return res;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("front page stayed at 202");
}

describe("front page endpoint fallback (brief 15)", () => {
  it("all fail: endpoint returns HTML payload instead of null", async () => {
    const { gen } = fakeGen({ edits: ["filtered", "filtered"], gens: ["filtered"] });
    const { app, id } = makeApp(gen);
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/debrief`,
      payload: { stillBase64: Buffer.from(still.image).toString("base64"), stillMime: "image/jpeg" },
    });
    expect(res.statusCode).toBe(200);
    const fp = await pollFrontPage(app, id);
    expect(fp.statusCode).toBe(200);
    const body = fp.json();
    expect(body.frontPage.kind).toBe("html");
    expect(body.frontPage.headline).toBe(sampleDebrief.front_page.headline);
    expect(body.frontPage.photoBase64).toBeTruthy();
    expect(body.step).toBe("html");
    await app.close();
  });

  it("no image provider configured: endpoint still returns HTML payload", async () => {
    const { app, id } = makeApp(null);
    await app.inject({ method: "POST", url: `/api/sessions/${id}/debrief`, payload: {} });
    const fp = await pollFrontPage(app, id);
    expect(fp.json().frontPage.kind).toBe("html");
    await app.close();
  });

  it("retry starts from the next step down, not the top", async () => {
    const { gen, calls } = fakeGen({ edits: ["filtered", "ok", "ok"], gens: ["ok"] });
    const { app, id } = makeApp(gen);
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/debrief`,
      payload: { stillBase64: Buffer.from(still.image).toString("base64"), stillMime: "image/jpeg" },
    });
    const fp = await pollFrontPage(app, id);
    expect(fp.json().step).toBe("edit_minimal");
    expect(fp.json().nextStep).toBe("generate_storefront");
    const before = calls.length;
    const retry = await app.inject({ method: "POST", url: `/api/sessions/${id}/front-page/retry`, payload: {} });
    expect(retry.statusCode).toBe(202);
    const fp2 = await pollFrontPage(app, id);
    expect(fp2.json().step).toBe("generate_storefront");
    // Only the storefront generation ran on retry: no edit was repeated.
    expect(calls.slice(before).map((c) => c.kind)).toEqual(["generate"]);
    await app.close();
  });
});
