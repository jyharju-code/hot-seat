import Fastify, { type FastifyInstance } from "fastify";
import type {
  CreateScenarioResponse,
  DebriefResponse,
  HealthResponse,
  ProvidersResponse,
} from "@hot-seat/shared";
import { providerStatuses, type Config } from "./config.js";
import { DebriefCoach, generateFrontPage, type DebriefGenerator } from "./debrief.js";
import { MetaImageGen, type ImageGen } from "./providers/image-gen.js";
import { MetaLlm } from "./providers/meta-llm.js";
import { CrisisDirector, type ScenarioGenerator } from "./scenarios/director.js";
import { presets } from "./scenarios/presets.js";
import { ScenarioStore } from "./scenarios/store.js";
import { SessionStore } from "./session/store.js";

export const SERVER_VERSION = "0.1.0";
export const MAX_STILL_BYTES = 2 * 1024 * 1024;

export interface AppDeps {
  generateScenario?: ScenarioGenerator;
  store?: ScenarioStore;
  generateDebrief?: DebriefGenerator;
  imageGen?: ImageGen | null;
  sessions?: SessionStore;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: config.NODE_ENV !== "test" });
  const store = deps.store ?? new ScenarioStore(config.dataDir);

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

  const sessions = deps.sessions ?? new SessionStore(config.dataDir);

  const debriefGen: DebriefGenerator =
    deps.generateDebrief ??
    (async (scenario, turns, language) => {
      if (!config.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not configured on the server");
      const coach = new DebriefCoach(
        new MetaLlm({ apiKey: config.MODEL_API_KEY, structuredModel: "muse-wonder-1.0" }),
        "muse-wonder-1.0",
        "medium",
      );
      return coach.generate(scenario, turns, language);
    });

  const imageGen: ImageGen | null =
    deps.imageGen !== undefined
      ? deps.imageGen
      : config.MODEL_API_KEY
        ? new MetaImageGen({ apiKey: config.MODEL_API_KEY })
        : null;

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/sessions/:id/debrief",
    { bodyLimit: MAX_STILL_BYTES * 2 },
    async (request, reply) => {
      const id = request.params.id;
      const record = sessions.get(id);
      const scenario = record?.scenario ?? store.get(id);
      if (!scenario) {
        return reply.code(404).send({ error: "Unknown session." });
      }
      const turns = record?.turns ?? [];
      const body = (request.body ?? {}) as {
        stillBase64?: unknown;
        stillMime?: unknown;
        language?: unknown;
      };
      let still: { image: Uint8Array; mimeType: string } | null = null;
      if (typeof body.stillBase64 === "string" && body.stillBase64.length > 0) {
        // Accept a data URL or bare base64.
        const raw = body.stillBase64.includes(",")
          ? body.stillBase64.slice(body.stillBase64.indexOf(",") + 1)
          : body.stillBase64;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(raw, "base64");
        } catch {
          return reply.code(400).send({ error: "Camera still is not valid base64." });
        }
        if (bytes.length === 0 || bytes.length > MAX_STILL_BYTES) {
          return reply.code(400).send({ error: "Camera still must be at most 2 MB." });
        }
        still = {
          image: new Uint8Array(bytes),
          mimeType: typeof body.stillMime === "string" ? body.stillMime : "image/jpeg",
        };
      }
      const language = typeof body.language === "string" ? body.language : "en";

      const debriefStarted = performance.now();
      let debrief;
      try {
        debrief = await debriefGen(scenario, turns, language);
      } catch (err) {
        const ms = Math.round(performance.now() - debriefStarted);
        app.log.error(
          `[debrief] generation failed after ${ms}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.code(502).send({ error: "Debrief generation failed. Please try again." });
      }
      const debriefMs = Math.round(performance.now() - debriefStarted);
      app.log.info(`[debrief] generated in ${debriefMs}ms`);
      if (record) {
        record.debrief = debrief;
        try {
          sessions.put(record);
        } catch {
          /* persistence is best effort */
        }
      }

      // Start the image as soon as the debrief JSON exists.
      let frontPage: DebriefResponse["frontPage"] = null;
      if (imageGen) {
        const imageStarted = performance.now();
        try {
          const result = await generateFrontPage(imageGen, debrief, scenario, still);
          const imageMs = Math.round(performance.now() - imageStarted);
          app.log.info(`[front-page] generated in ${imageMs}ms`);
          frontPage = {
            imageBase64: Buffer.from(result.image).toString("base64"),
            mime: result.mimeType,
          };
        } catch (err) {
          const imageMs = Math.round(performance.now() - imageStarted);
          app.log.error(
            `[front-page] generation failed after ${imageMs}ms: ${err instanceof Error ? err.message : String(err)}`,
          );
          frontPage = null;
        }
      } else {
        app.log.info("[front-page] skipped: image generation is not configured");
      }

      const response: DebriefResponse = { debrief, frontPage };
      return response;
    },
  );

  return app;
}
