import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, providerStatuses } from "../src/config.js";
import { MetaLlm } from "../src/providers/meta-llm.js";
import { StubImageGen, StubSpeechToText, StubTextToSpeech, NotImplementedError } from "../src/providers/index.js";

describe("config", () => {
  it("applies defaults and treats empty keys as unset", () => {
    const c = loadConfig({ MODEL_API_KEY: "" });
    expect(c.PORT).toBe(3001);
    expect(c.MODEL_API_KEY).toBeUndefined();
  });
  it("rejects a bad port", () => {
    expect(() => loadConfig({ PORT: "nope" })).toThrow(/Invalid configuration/);
  });
  it("provider statuses never expose secrets", () => {
    const s = providerStatuses(loadConfig({ MODEL_API_KEY: "secret-value" }));
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(s.find((p) => p.id === "llm")?.configured).toBe(true);
    expect(s.find((p) => p.id === "text-to-speech")?.configured).toBe(false);
  });
});

describe("http app", () => {
  it("GET /api/health returns ok", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });
  it("GET /api/providers lists four providers without secrets", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test", ELEVENLABS_API_KEY: "x-secret" }));
    const res = await app.inject({ method: "GET", url: "/api/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toHaveLength(4);
    expect(res.body).not.toContain("x-secret");
    await app.close();
  });
});

describe("MetaLlm adapter (mocked fetch)", () => {
  it("chat posts to /chat/completions and returns text", async () => {
    let url = "";
    let auth = "";
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = String(u);
      auth = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ model: "muse-spark-1.0", choices: [{ message: { content: "Hello." }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    const out = await llm.chat({ messages: [{ role: "user", content: "Hi" }] });
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(auth).toBe("Bearer k");
    expect(out.text).toBe("Hello.");
  });
  it("generateStructured parses JSON from the Responses API", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ output_text: '{"title":"Crisis"}' }), { status: 200 })) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    const out = await llm.generateStructured({ prompt: "Make one", parse: (raw) => (raw as { title: string }).title });
    expect(out).toBe("Crisis");
  });
});

describe("stub adapters", () => {
  it("throw NotImplemented", async () => {
    await expect(new StubImageGen().editPhoto({ image: new Uint8Array(), mimeType: "image/png", prompt: "x" })).rejects.toBeInstanceOf(NotImplementedError);
    const drain = async (iterable: AsyncIterable<unknown>) => { for await (const _ of iterable) { void _; } };
    await expect(drain(new StubTextToSpeech().synthesize("hi"))).rejects.toBeInstanceOf(NotImplementedError);
    async function* audio() { yield new Uint8Array([1]); }
    await expect(drain(new StubSpeechToText().transcribe(audio()))).rejects.toBeInstanceOf(NotImplementedError);
  });
});

const hasKey = Boolean(process.env.MODEL_API_KEY);
describe.skipIf(!hasKey)("Meta Model API integration (live)", () => {
  it("answers a short chat", async () => {
    const llm = new MetaLlm({ apiKey: process.env.MODEL_API_KEY as string });
    const out = await llm.chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 16 });
    expect(out.text.length).toBeGreaterThan(0);
  }, 30_000);
});
