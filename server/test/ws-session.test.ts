import { describe, expect, it } from "vitest";
import { attachSessionSocket } from "../src/ws-session.js";
import type { SessionRecord } from "../src/session/store.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...args: never[]) => void>>();
  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  send(data: string): void { this.sent.push(data); }
  emitMessage(text: string): void { for (const cb of this.handlers.get("message") ?? []) cb(Buffer.from(text) as never, false as never); }
  emitClose(): void { this.readyState = 3; for (const cb of this.handlers.get("close") ?? []) cb(); }
  json(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}

function fakeOrchestrator() {
  return {
    started: 0,
    stopped: 0,
    async start(): Promise<void> { this.started += 1; },
    async stop(): Promise<void> { this.stopped += 1; },
    async playbackDone(): Promise<void> { /* noop */ },
    pushAudio(): void { /* noop */ },
  };
}
type FakeOrch = ReturnType<typeof fakeOrchestrator>;
const tick = () => new Promise((r) => setTimeout(r, 0));
const record = (id: string): SessionRecord => ({ id, scenario: cafeTestScenario, startedAtMs: 0, turns: [] });

describe("WS session lifecycle (brief 08 items 1 and 8)", () => {
  it("a second start stops the previous orchestrator and issues a new session id", async () => {
    const ws = new FakeSocket();
    const orchs: FakeOrch[] = [];
    const persisted: string[] = [];
    let n = 0;
    attachSessionSocket(ws as never, {
      build: async () => {
        n += 1;
        const orch = fakeOrchestrator();
        orchs.push(orch);
        return { orchestrator: orch, record: record(`sess-${n}`) };
      },
      persist: (r) => persisted.push(r.id),
    });
    ws.emitMessage(JSON.stringify({ type: "start", scenarioId: "scen-1" }));
    await tick(); await tick();
    ws.emitMessage(JSON.stringify({ type: "start", scenarioId: "scen-1" }));
    await tick(); await tick();
    expect(orchs).toHaveLength(2);
    expect(orchs[0]!.stopped).toBe(1);
    expect(orchs[1]!.started).toBe(1);
    expect(ws.json()).toContainEqual({ type: "session_started", sessionId: "sess-1" });
    expect(ws.json()).toContainEqual({ type: "session_started", sessionId: "sess-2" });
    void persisted;
  });

  it("a disconnect during the start awaits never starts an orphan session", async () => {
    const ws = new FakeSocket();
    const orch = fakeOrchestrator();
    let releaseBuild!: () => void;
    const gate = new Promise<void>((r) => { releaseBuild = r; });
    attachSessionSocket(ws as never, {
      build: async () => { await gate; return { orchestrator: orch, record: record("sess-x") }; },
      persist: () => undefined,
    });
    ws.emitMessage(JSON.stringify({ type: "start", scenarioId: "scen-1" }));
    await tick();
    ws.emitClose();
    releaseBuild();
    await tick(); await tick();
    expect(orch.started).toBe(0);
  });
});
