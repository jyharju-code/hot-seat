import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionStore } from "../src/session/store.js";
import { debriefSchema } from "@hot-seat/shared";

const sampleDebrief = {
  scores: { clarity: 70, accountability: 40, composure: 80, message_discipline: 55, empathy: 60 },
  verdict: "You stayed calm but dodged the key question.",
  best_moments: [{ t: "00:20", quote: "We pulled the pastries at once.", why: "Specific action." }],
  worst_moments: [],
  headline_quote: "We knew nothing about it.",
  front_page: { headline: "WE KNEW NOTHING", subhead: "Cafe owner faces questions" },
  landmines: [{ id: "L1", handled: false, comment: "You denied knowledge." }],
  one_thing_to_practice: "Say what you knew and when.",
};

const tmp = () => mkdtempSync(path.join(tmpdir(), "hot-seat-store-"));

describe("File-backed stores (brief 07b)", () => {
  it("scenario survives a restart (new instance, same dir)", () => {
    const dir = tmp();
    const id = new ScenarioStore(dir).add(cafeTestScenario);
    const files = readdirSync(dir);
    expect(files).toEqual([`scenarios-${id}.json`]);
    const after = new ScenarioStore(dir);
    expect(after.get(id)?.company.name).toBe("Kettle & Crumb");
    expect(after.has(id)).toBe(true);
  });

  it("unknown id returns undefined", () => {
    const dir = tmp();
    expect(new ScenarioStore(dir).get("no-such-id")).toBeUndefined();
    expect(new SessionStore(dir).get("no-such-id")).toBeUndefined();
    expect(new ScenarioStore(dir).get("../escape")).toBeUndefined();
  });

  it("invalid file is rejected, not returned", () => {
    const dir = tmp();
    const store = new ScenarioStore(dir);
    const id = store.add(cafeTestScenario);
    writeFileSync(path.join(dir, `scenarios-${id}.json`), JSON.stringify({ bogus: true }));
    writeFileSync(path.join(dir, "scenarios-broken.json"), "{not json");
    // New instance: no cache, must validate from disk.
    const fresh = new ScenarioStore(dir);
    expect(fresh.get(id)).toBeUndefined();
    expect(fresh.get("broken")).toBeUndefined();
  });

  it("session record (transcript, events, debrief) survives a restart", () => {
    const dir = tmp();
    const sessions = new SessionStore(dir);
    const record = sessions.start("sess-1", cafeTestScenario, 1234);
    record.turns.push(
      { role: "reporter", text: "When did you know?", elapsedSeconds: 0, flags: [] },
      { role: "user", text: "That morning.", elapsedSeconds: 9, flags: ["dodge"], interruptReason: undefined },
    );
    record.debrief = debriefSchema.parse(sampleDebrief);
    sessions.put(record);

    const after = new SessionStore(dir).get("sess-1");
    expect(after?.startedAtMs).toBe(1234);
    expect(after?.turns.map((t) => t.text)).toEqual(["When did you know?", "That morning."]);
    expect(after?.turns[1]?.flags).toEqual(["dodge"]);
    expect(after?.debrief?.verdict).toContain("dodged");
    expect(after?.scenario.company.name).toBe("Kettle & Crumb");
  });

  it("invalid session file is rejected", () => {
    const dir = tmp();
    new SessionStore(dir).put({ id: "s-bad", scenario: cafeTestScenario, startedAtMs: 0, turns: [] });
    writeFileSync(path.join(dir, "sessions-s-bad.json"), JSON.stringify({ id: "s-bad" }));
    expect(new SessionStore(dir).get("s-bad")).toBeUndefined();
  });
});
