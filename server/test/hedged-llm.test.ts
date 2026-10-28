import { describe, expect, it } from "vitest";
import type { Llm, LlmChatInput, LlmChatResult } from "../src/providers/llm.js";
import { HedgedLlm, HEDGE_AFTER_MS } from "../src/providers/hedged-llm.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeProvider implements Llm {
  calls = 0;
  aborted = false;
  lastModel: string | undefined;
  constructor(
    private readonly opts: { delayMs: number; text?: string; error?: Error },
  ) {}
  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    this.calls += 1;
    this.lastModel = input.model;
    input.signal?.addEventListener("abort", () => (this.aborted = true), { once: true });
    if (this.opts.delayMs > 0) await wait(this.opts.delayMs);
    if (input.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (this.opts.error) throw this.opts.error;
    return { text: this.opts.text ?? "{}", model: input.model ?? "m", finishReason: "stop" };
  }
  async generateStructured<T>(): Promise<T> {
    throw new Error("not used");
  }
}

function hedged(primary: FakeProvider, hedge: FakeProvider, logs: string[], hedgeAfterMs = 50) {
  return new HedgedLlm({
    primary: { name: "meta", llm: primary, model: "meta-model" },
    hedge: { name: "baseten", llm: hedge, model: "baseten-model" },
    hedgeAfterMs,
    log: (l) => logs.push(l),
  });
}

describe("HedgedLlm", () => {
  it("exports the default hedge delay", () => {
    expect(HEDGE_AFTER_MS).toBe(1800);
  });

  it("fast primary wins without a hedge", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, text: "primary" });
    const hedge = new FakeProvider({ delayMs: 5, text: "hedge" });
    const llm = hedged(primary, hedge, logs);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }], model: "ignored" });
    expect(res.text).toBe("primary");
    expect(primary.calls).toBe(1);
    expect(hedge.calls).toBe(0);
    expect(primary.lastModel).toBe("meta-model");
    expect(logs.some((l) => /^hedge: fired=false winner=meta ms=\d+$/.test(l))).toBe(true);
  });

  it("slow primary loses to the hedge and the loser is aborted", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 500, text: "primary" });
    const hedge = new FakeProvider({ delayMs: 10, text: "hedge" });
    const llm = hedged(primary, hedge, logs);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("hedge");
    expect(hedge.calls).toBe(1);
    expect(hedge.lastModel).toBe("baseten-model");
    expect(primary.aborted).toBe(true);
    expect(logs.some((l) => /^hedge: fired=true winner=baseten ms=\d+$/.test(l))).toBe(true);
  });

  it("a failing primary falls to the hedge without waiting the full delay", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, error: new Error("primary down") });
    const hedge = new FakeProvider({ delayMs: 10, text: "hedge" });
    const llm = hedged(primary, hedge, logs, 5000);
    const started = Date.now();
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("hedge");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs.some((l) => /^hedge: fired=true winner=baseten ms=\d+$/.test(l))).toBe(true);
  });

  it("throws when both providers fail", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, error: new Error("primary down") });
    const hedge = new FakeProvider({ delayMs: 5, error: new Error("hedge down") });
    const llm = hedged(primary, hedge, logs);
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/hedge down|primary down/);
  });
});

function raced(primary: FakeProvider, second: FakeProvider, logs: string[]) {
  return new HedgedLlm({
    primary: { name: "meta", llm: primary, model: "meta-model" },
    hedge: { name: "baseten", llm: second, model: "baseten-model" },
    mode: "race",
    log: (l) => logs.push(l),
  });
}

describe("HedgedLlm race mode (TURN_RACE=on)", () => {
  it("starts both at once: fast Baseten wins, slow Meta is aborted", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 500, text: "primary" });
    const second = new FakeProvider({ delayMs: 10, text: "second" });
    const llm = raced(primary, second, logs);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("second");
    expect(primary.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(primary.aborted).toBe(true);
    expect(llm.lastWinner).toBe("baseten");
    expect(logs.some((l) => /^race: winner=baseten ms=\d+ loser_ms=aborted$/.test(l))).toBe(true);
  });

  it("fast Meta wins and Baseten is aborted", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, text: "primary" });
    const second = new FakeProvider({ delayMs: 500, text: "second" });
    const llm = raced(primary, second, logs);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("primary");
    expect(second.aborted).toBe(true);
    expect(llm.lastWinner).toBe("meta");
    expect(logs.some((l) => /^race: winner=meta ms=\d+ loser_ms=aborted$/.test(l))).toBe(true);
  });

  it("a fast failure does not end the race: the slower provider wins with a numeric loser_ms", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, error: new Error("primary down") });
    const second = new FakeProvider({ delayMs: 30, text: "second" });
    const llm = raced(primary, second, logs);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("second");
    expect(logs.some((l) => /^race: winner=baseten ms=\d+ loser_ms=\d+$/.test(l))).toBe(true);
  });

  it("throws when both providers fail in race mode", async () => {
    const logs: string[] = [];
    const primary = new FakeProvider({ delayMs: 5, error: new Error("primary down") });
    const second = new FakeProvider({ delayMs: 5, error: new Error("second down") });
    const llm = raced(primary, second, logs);
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/primary down|second down/);
    expect(llm.lastWinner).toBeNull();
  });
});
