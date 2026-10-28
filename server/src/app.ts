import Fastify, { type FastifyInstance } from "fastify";
import type { CreateScenarioResponse, HealthResponse, ProvidersResponse } from "@hot-seat/shared";
import { providerStatuses, type Config } from "./config.js";
import { MetaLlm } from "./providers/meta-llm.js";
import { CrisisDirector, type ScenarioGenerator } from "./scenarios/director.js";
import { presets } from "./scenarios/presets.js";
import { scenarioStore, type ScenarioStore } from "./scenarios/store.js";

export const SERVER_VERSION = "0.1.0";

export interface AppDeps {
  generateScenario?: ScenarioGenerator;
  store?: ScenarioStore;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: config.NODE_ENV !== "test" });
  const store = deps.store ?? scenarioStore;

  const generate: ScenarioGenerator =
    deps.generateScenario ??
    (async (description, language) => {
      if (!config.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not configured on the server");
      const director = new CrisisDirector(
        new MetaLlm({ apiKey: config.MODEL_API_KEY, structuredModel: config.scenarioModel }),
        config.scenarioModel,
        config.scenarioReasoning,
      );
      return director.generate(description, language);
    });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "hot-seat-server",
    version: SERVER_VERSION,
  }));

  app.get("/api/providers", async (): Promise<ProvidersResponse> => ({
    providers: providerStatuses(config),
  }));

  app.get("/api/presets", async () => ({ presets }));

  app.post<{ Body: unknown }>("/api/scenarios", async (request, reply) => {
    const body = (request.body ?? {}) as { description?: unknown; language?: unknown };
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < 10 || description.length > 600) {
      return reply.code(400).send({ error: "Description must be between 10 and 600 characters." });
    }
    const language = body.language === undefined ? "en" : body.language;
    if (language !== "en") {
      return reply.code(400).send({ error: 'Only language "en" is supported.' });
    }
    const started = performance.now();
    try {
      const scenario = await generate(description, language);
      const ms = Math.round(performance.now() - started);
      app.log.info(`[scenario] generated in ${ms}ms`);
      const id = store.add(scenario);
      const response: CreateScenarioResponse = { id, scenario };
      return response;
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      app.log.error(`[scenario] generation failed after ${ms}ms: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(502).send({ error: "Scenario generation failed. Please try again." });
    }
  });

  return app;
}
