import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GeneratedScenario } from "@hot-seat/shared";
import { apiPathNeedsCode, buildApp } from "../src/app.js";
import { httpCodeFromRequest, isAccessAllowed, isWsUpgradeAllowed, wsCodeFromUrl } from "../src/access.js";
import { SessionCaps } from "../src/caps.js";
import { loadConfig, resolveListen } from "../src/config.js";
import { cafeTestScenario } from "../src/scenarios/cafe.js";
import { ScenarioStore } from "../src/scenarios/store.js";
import { SessionStore } from "../src/session/store.js";
import type { SessionRecord } from "../src/session/store.js";

const CODE = "judge-code-123";

function memoryBacking<T>() {
  const map = new Map<string, T>();
  return {
    get: (id: string) => map.get(id),
    put: (id: string, value: T) => {
      map.set(id, value);
    },
    has: (id: string) => map.has(id),
  };
}

function testDeps() {
  return {
    store: new ScenarioStore({ store: memoryBacking<GeneratedScenario>() }),
    sessions: new SessionStore({ store: memoryBacking<SessionRecord>() }),
  };
}

const SCENARIO_BODY = {
  description: "My café in Leeds found glass in a croissant and the post is everywhere.",
  language: "en",
};

describe("access code gate", () => {
  it("answers 401 without the code and 200 with it; /api/health stays open", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test", ACCESS_CODE: CODE }), {
      ...testDeps(),
      generateScenario: async () => cafeTestScenario,
    });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    const denied = await app.inject({ method: "GET", url: "/api/presets" });
    expect(denied.statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/api/presets", headers: { "x-access-code": "nope" } });
    expect(wrong.statusCode).toBe(401);
    const allowed = await app.inject({ method: "GET", url: "/api/presets", headers: { "x-access-code": CODE } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().presets.length).toBeGreaterThan(0);
    const post = await app.inject({ method: "POST", url: "/api/scenarios", payload: SCENARIO_BODY, headers: { "x-access-code": CODE } });
    expect(post.statusCode).toBe(200);
    await app.close();
  });
  it("accepts ?code= on HTTP for media URLs that cannot set headers", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test", ACCESS_CODE: CODE }), testDeps());
    const res = await app.inject({ method: "GET", url: `/api/presets?code=${CODE}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
  it("enforces nothing when ACCESS_CODE is unset", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), {
      ...testDeps(),
      generateScenario: async () => cafeTestScenario,
    });
    const presets = await app.inject({ method: "GET", url: "/api/presets" });
    expect(presets.statusCode).toBe(200);
    const post = await app.inject({ method: "POST", url: "/api/scenarios", payload: SCENARIO_BODY });
    expect(post.statusCode).toBe(200);
    await app.close();
  });
  it("never exposes the code in 401 bodies", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test", ACCESS_CODE: CODE }), testDeps());
    const res = await app.inject({ method: "GET", url: "/api/presets" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(CODE);
    await app.close();
  });
});

describe("access helpers", () => {
  it("matches the code exactly and allows everything when unset", () => {
    expect(isAccessAllowed(null, undefined)).toBe(true);
    expect(isAccessAllowed(null, CODE)).toBe(false);
    expect(isAccessAllowed("", CODE)).toBe(false);
    expect(isAccessAllowed("nope", CODE)).toBe(false);
    expect(isAccessAllowed(CODE, CODE)).toBe(true);
  });
  it("reads ?code= from URLs", () => {
    expect(wsCodeFromUrl("/ws")).toBeNull();
    expect(wsCodeFromUrl(undefined)).toBeNull();
    expect(wsCodeFromUrl(`/ws?code=${CODE}`)).toBe(CODE);
    expect(httpCodeFromRequest(CODE, "/api/presets")).toBe(CODE);
    expect(httpCodeFromRequest(undefined, `/api/presets?code=${CODE}`)).toBe(CODE);
    expect(httpCodeFromRequest(undefined, "/api/presets")).toBeNull();
  });
  it("refuses the /ws upgrade without the code", () => {
    expect(isWsUpgradeAllowed("/ws", CODE)).toBe(false);
    expect(isWsUpgradeAllowed(`/ws?code=${CODE}`, CODE)).toBe(true);
    expect(isWsUpgradeAllowed("/ws?code=nope", CODE)).toBe(false);
    expect(isWsUpgradeAllowed("/ws", undefined)).toBe(true);
  });
  it("only /api/* except /api/health needs the code", () => {
    expect(apiPathNeedsCode("/api/health")).toBe(false);
    expect(apiPathNeedsCode("/api/health?deep=1")).toBe(false);
    expect(apiPathNeedsCode("/api/presets")).toBe(true);
    expect(apiPathNeedsCode("/api/scenarios")).toBe(true);
    expect(apiPathNeedsCode("/")).toBe(false);
    expect(apiPathNeedsCode("/some/client/route")).toBe(false);
  });
});

describe("session caps", () => {
  async function postScenario(app: FastifyInstance) {
    return app.inject({ method: "POST", url: "/api/scenarios", payload: SCENARIO_BODY });
  }
  it("refuses the N+1th session over the daily cap without a model call", async () => {
    let calls = 0;
    const app = buildApp(loadConfig({ NODE_ENV: "test", MAX_SESSIONS_PER_DAY: "2", MAX_SESSIONS_PER_IP_PER_HOUR: "0" }), {
      ...testDeps(),
      generateScenario: async () => {
        calls += 1;
        return cafeTestScenario;
      },
    });
    expect((await postScenario(app)).statusCode).toBe(200);
    expect((await postScenario(app)).statusCode).toBe(200);
    const refused = await postScenario(app);
    expect(refused.statusCode).toBe(429);
    expect(calls).toBe(2);
    await app.close();
  });
  it("refuses the N+1th session over the per-IP hourly cap without a model call", async () => {
    let calls = 0;
    const app = buildApp(loadConfig({ NODE_ENV: "test", MAX_SESSIONS_PER_DAY: "0", MAX_SESSIONS_PER_IP_PER_HOUR: "2" }), {
      ...testDeps(),
      generateScenario: async () => {
        calls += 1;
        return cafeTestScenario;
      },
    });
    expect((await postScenario(app)).statusCode).toBe(200);
    expect((await postScenario(app)).statusCode).toBe(200);
    expect((await postScenario(app)).statusCode).toBe(429);
    expect(calls).toBe(2);
    await app.close();
  });
  it("zero disables both caps", async () => {
    let calls = 0;
    const app = buildApp(loadConfig({ NODE_ENV: "test", MAX_SESSIONS_PER_DAY: "0", MAX_SESSIONS_PER_IP_PER_HOUR: "0" }), {
      ...testDeps(),
      generateScenario: async () => {
        calls += 1;
        return cafeTestScenario;
      },
    });
    for (let i = 0; i < 4; i += 1) expect((await postScenario(app)).statusCode).toBe(200);
    expect(calls).toBe(4);
    await app.close();
  });
  it("unit: day and ip windows refuse independently", () => {
    const day = new SessionCaps({ maxSessionsPerDay: 1, maxSessionsPerIpPerHour: 0 });
    expect(day.checkAndRecord("a", 1_000)).toBeNull();
    expect(day.checkAndRecord("b", 2_000)).toBe("day");
    expect(day.checkAndRecord("c", 24 * 60 * 60 * 1000 + 3_000)).toBeNull();
    const ip = new SessionCaps({ maxSessionsPerDay: 0, maxSessionsPerIpPerHour: 1 });
    expect(ip.checkAndRecord("a", 1_000)).toBeNull();
    expect(ip.checkAndRecord("a", 2_000)).toBe("ip");
    expect(ip.checkAndRecord("b", 2_000)).toBeNull();
    expect(ip.checkAndRecord("a", 3_700_000)).toBeNull();
  });
});

describe("deep health check", () => {
  it("returns only reachability, caches for 30 s, never leaks the key", async () => {
    const key = "meta-key-abc";
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [{ id: "muse-spark-1.3" }, { id: "muse-wonder-1.0" }], key }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = buildApp(loadConfig({ NODE_ENV: "test", MODEL_API_KEY: key }), { ...testDeps(), metaModelsFetch: fetchFn });
    const plain = await app.inject({ method: "GET", url: "/api/health" });
    expect(plain.json().meta).toBeUndefined();
    const deep = await app.inject({ method: "GET", url: "/api/health?deep=1" });
    expect(deep.statusCode).toBe(200);
    expect(deep.json().meta).toMatchObject({ status: "ok", model_count: 2 });
    expect(typeof deep.json().meta.ms).toBe("number");
    expect(deep.body).not.toContain(key);
    const cached = await app.inject({ method: "GET", url: "/api/health?deep=1" });
    expect(cached.statusCode).toBe(200);
    expect(calls).toBe(1);
    await app.close();
  });
});

describe("production static serving", () => {
  function fixtureDir() {
    const dir = path.join(tmpdir(), `hot-seat-static-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>hot seat.</body></html>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    return dir;
  }
  it("serves index.html for / and client routes, JSON for /api/presets", async () => {
    const app = buildApp(loadConfig({ NODE_ENV: "test" }), { ...testDeps(), staticDir: fixtureDir() });
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("hot seat.");
    const route = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("hot seat.");
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    const api = await app.inject({ method: "GET", url: "/api/presets" });
    expect(api.statusCode).toBe(200);
    expect(api.json().presets.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe("listen address", () => {
  const base = { SERVER_HOST: "127.0.0.1", SERVER_PORT: 3001 };
  it("uses local defaults when PORT is unset", () => {
    expect(resolveListen({}, base)).toEqual({ host: "127.0.0.1", port: 3001 });
    expect(resolveListen({ PORT: "" }, base)).toEqual({ host: "127.0.0.1", port: 3001 });
    expect(resolveListen({ PORT: "nope" }, base)).toEqual({ host: "127.0.0.1", port: 3001 });
  });
  it("PORT wins over SERVER_PORT and binds 0.0.0.0", () => {
    expect(resolveListen({ PORT: "10000" }, base)).toEqual({ host: "0.0.0.0", port: 10000 });
    expect(resolveListen({ PORT: "10000" }, { SERVER_HOST: "127.0.0.1", SERVER_PORT: 4000 })).toEqual({
      host: "0.0.0.0",
      port: 10000,
    });
  });
});
