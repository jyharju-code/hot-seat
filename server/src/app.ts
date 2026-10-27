import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse, ProvidersResponse } from "@hot-seat/shared";
import { providerStatuses, type Config } from "./config.js";

export const SERVER_VERSION = "0.1.0";

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: config.NODE_ENV !== "test" });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "hot-seat-server",
    version: SERVER_VERSION,
  }));

  app.get("/api/providers", async (): Promise<ProvidersResponse> => ({
    providers: providerStatuses(config),
  }));

  return app;
}
