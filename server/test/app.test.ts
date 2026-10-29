import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, providerStatuses } from "../src/config.js";
import { MetaLlm } from "../src/providers/meta-llm.js";
import { BasetenLlm } from "../src/providers/baseten-llm.js";
import { StubImageGen, StubSpeechToText, StubTextToSpeech, NotImplementedError } from "../src/providers/index.js";

describe("config", () => {
  it("applies defaults and treats empty keys as unset", () => {
    const c = loadConfig({ MODEL_API_KEY: "" });
    expect(c.SERVER_PORT).toBe(3001);
    expect(c.SERVER_HOST).toBe("127.0.0.1");
    expect(c.MODEL_API_KEY).toBeUndefined();
  });
  it("rejects a bad port", () => {
    expect(() => loadConfig({ SERVER_PORT: "nope" })).toThrow(/Invalid configuration/);
  });
  it("PORT alone does not change the server port", () => {
    expect(loadConfig({ PORT: "5173" }).SERVER_PORT).toBe(3001);
    expect(loadConfig({ PORT: "nope" }).SERVER_PORT).toBe(3001);
  });
  it("SERVER_PORT and SERVER_HOST override the defaults", () => {
    const c = loadConfig({ SERVER_PORT: "4000", SERVER_HOST: "0.0.0.0" });
    expect(c.SERVER_PORT).toBe(4000);
    expect(c.SERVER_HOST).toBe("0.0.0.0");
  });
  it("defaults the chat model to muse-spark-1.3", () => {
    expect(loadConfig({}).llmChatModel).toBe("muse-spark-1.3");
  });
  it("defaults TURN_LLM to meta and scenario generation to wonder medium", () => {
    const c = loadConfig({});
    expect(c.turnLlm).toBe("meta");
    expect(c.scenarioModel).toBe("muse-wonder-1.0");
    expect(c.scenarioReasoning).toBe("medium");
    const c2 = loadConfig({ TURN_LLM: "baseten", SCENARIO_MODEL: "muse-spark-1.3", SCENARIO_REASONING: "low" });
    expect(c2.turnLlm).toBe("baseten");
    expect(c2.scenarioModel).toBe("muse-spark-1.3");
    expect(c2.scenarioReasoning).toBe("low");
    expect(() => loadConfig({ TURN_LLM: "other" })).toThrow(/Invalid configuration/);
  });
  it("/api/providers shows the turn provider in use", () => {
    const meta = providerStatuses(loadConfig({ MODEL_API_KEY: "x" }));
    expect(meta.find((p) => p.id === "llm")?.adapter).toContain("Meta");
    const baseten = providerStatuses(loadConfig({ TURN_LLM: "baseten", BASETEN_API_KEY: "y-secret" }));
    expect(baseten.find((p) => p.id === "llm")?.adapter).toContain("Baseten");
    expect(baseten.find((p) => p.id === "llm")?.configured).toBe(true);
    expect(JSON.stringify(baseten)).not.toContain("y-secret");
  });
  it("provider statuses never expose secrets", () => {
    const s = providerStatuses(loadConfig({ MODEL_API_KEY: "secret-value" }));
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(s.find((p) => p.id === "llm")?.configured).toBe(true);
    // Browser TTS is always available (on-device, not a model call).
    expect(s.find((p) => p.id === "text-to-speech")?.configured).toBe(true);
    // TTS_PROVIDER=elevenlabs without a key falls back to browser (configured).
    const eleven = providerStatuses(loadConfig({ TTS_PROVIDER: "elevenlabs" }));
    expect(eleven.find((p) => p.id === "text-to-speech")?.adapter).toBe("Browser speech synthesis");
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
      return new Response(JSON.stringify({ model: "muse-spark-1.3", choices: [{ message: { content: "Hello." }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    const out = await llm.chat({ messages: [{ role: "user", content: "Hi" }] });
    expect(url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(auth).toBe("Bearer k");
    expect(out.text).toBe("Hello.");
  });
  it("chat defaults to muse-spark-1.3", async () => {
    let bodyModel = "";
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      bodyModel = (JSON.parse(String(init?.body)) as { model: string }).model;
      return new Response(JSON.stringify({ model: bodyModel, choices: [{ message: { content: "Hi." }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    await llm.chat({ messages: [{ role: "user", content: "Hi" }] });
    expect(bodyModel).toBe("muse-spark-1.3");
  });
  it("chat with empty content reports finish_reason and usage", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ model: "muse-spark-1.3", choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210, completion_tokens_details: { reasoning_tokens: 200 } } }), { status: 200 })) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    await expect(llm.chat({ messages: [{ role: "user", content: "Hi" }], maxTokens: 200 })).rejects.toThrow(/empty content, finish_reason=length, reasoning_tokens=200/);
  });
  it("generateStructured parses JSON from the Responses API", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ output_text: '{"title":"Crisis"}' }), { status: 200 })) as typeof fetch;
    const llm = new MetaLlm({ apiKey: "k", fetchFn });
    const out = await llm.generateStructured({ prompt: "Make one", parse: (raw) => (raw as { title: string }).title });
    expect(out).toBe("Crisis");
  });
});

describe("BasetenLlm adapter (mocked fetch)", () => {
  it("posts to inference.baseten.co with Api-Key auth and the open model", async () => {
    let url = "";
    let auth = "";
    let bodyModel = "";
    let reasoning: unknown;
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = String(u);
      auth = String((init?.headers as Record<string, string>).authorization);
      const body = JSON.parse(String(init?.body)) as { model: string; reasoning_effort?: string };
      bodyModel = body.model;
      reasoning = body.reasoning_effort;
      return new Response(JSON.stringify({ model: bodyModel, choices: [{ message: { content: "Hi." }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    const llm = new BasetenLlm({ apiKey: "k", fetchFn });
    const out = await llm.chat({ messages: [{ role: "user", content: "Hi" }], reasoningEffort: "minimal" });
    expect(url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(auth).toBe("Api-Key k");
    expect(bodyModel).toBe("meta-models/muse-spark-open-1026");
    expect(reasoning).toBe("minimal");
    expect(out.text).toBe("Hi.");
  });
  it("chat with empty content reports finish_reason and usage", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210, completion_tokens_details: { reasoning_tokens: 200 } } }), { status: 200 })) as typeof fetch;
    const llm = new BasetenLlm({ apiKey: "k", fetchFn });
    await expect(llm.chat({ messages: [{ role: "user", content: "Hi" }], maxTokens: 200 })).rejects.toThrow(/empty content, finish_reason=length, reasoning_tokens=200/);
  });
  it("retries without reasoning_effort when the provider rejects it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("reasoning_effort" in body) return new Response("unknown field reasoning_effort", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Ok." }, finish_reason: "stop" }] }), { status: 200 });
    }) as typeof fetch;
    const llm = new BasetenLlm({ apiKey: "k", fetchFn });
    const out = await llm.chat({ messages: [{ role: "user", content: "Hi" }], reasoningEffort: "minimal" });
    expect(out.text).toBe("Ok.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
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
