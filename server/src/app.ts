import Fastify, { type FastifyInstance } from "fastify";
import type {
  CreateScenarioResponse,
  DebriefResponse,
  FrontPageResult,
  HealthResponse,
  ProvidersResponse,
} from "@hot-seat/shared";
import { BROWSER_TTS_LABEL, providerStatuses, type Config } from "./config.js";
import { buildHtmlFrontPage, DebriefCoach, generateFrontPage, type DebriefGenerator } from "./debrief.js";
import { classifyImageError, MetaImageGen, type ImageGen } from "./providers/image-gen.js";
import { FRONT_PAGE_STEPS, type FrontPageStep } from "@hot-seat/shared";
import { MetaLlm } from "./providers/meta-llm.js";
import { CrisisDirector, type ScenarioGenerator } from "./scenarios/director.js";
import { presets, profilePresets } from "./scenarios/presets.js";
import { ScenarioStore } from "./scenarios/store.js";
import { SessionStore } from "./session/store.js";
import { buildBrowserNewsClip, buildNewsClipAudio, NEWS_CLIP_VOICE_ID } from "./news/build-clip.js";
import { STUDIO_IMAGE_PROMPT } from "./news/clip.js";
import type { NewsTimelinePart } from "@hot-seat/shared";
import { ElevenLabsTextToSpeech, type TextToSpeech } from "./providers/text-to-speech.js";
import { ownerAudioRegistry } from "./session/owner-audio.js";

export const SERVER_VERSION = "0.1.0";
export const MAX_STILL_BYTES = 2 * 1024 * 1024;

export interface AppDeps {
  generateScenario?: ScenarioGenerator;
  store?: ScenarioStore;
  generateDebrief?: DebriefGenerator;
  imageGen?: ImageGen | null;
  sessions?: SessionStore;
  /** Anchor TTS for the news clip. Null disables clip building. */
  tts?: TextToSpeech | null;
  newsVoiceId?: string;
}

export function buildApp(config: Config, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: config.NODE_ENV !== "test" });
  const store = deps.store ?? new ScenarioStore(config.dataDir);

  const generate: ScenarioGenerator =
    deps.generateScenario ??
    (async (description, language, options) => {
      if (!config.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not configured on the server");
      const director = new CrisisDirector(
        new MetaLlm({ apiKey: config.MODEL_API_KEY, structuredModel: config.scenarioModel, chatTimeoutMs: config.turnLlmTimeoutMs, structuredTimeoutMs: config.scenarioTimeoutMs }),
        config.scenarioModel,
        config.scenarioReasoning,
        config.scenarioTimeoutMs,
      );
      return director.generate(description, language, options);
    });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "hot-seat-server",
    version: SERVER_VERSION,
    tts: config.ttsProvider === "browser" ? BROWSER_TTS_LABEL : "Text to speech: ElevenLabs eleven_v4",
    ttsProvider: config.ttsProvider,
  }));

  app.get("/api/providers", async (): Promise<ProvidersResponse> => ({
    providers: providerStatuses(config),
  }));

  app.get("/api/presets", async () => ({ presets, profilePresets }));

  app.post<{ Body: unknown }>("/api/scenarios", async (request, reply) => {
    const body = (request.body ?? {}) as { description?: unknown; language?: unknown; mode?: unknown; duration_minutes?: unknown; durationMinutes?: unknown };
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length < 10 || description.length > 600) {
      return reply.code(400).send({ error: "Description must be between 10 and 600 characters." });
    }
    const language = body.language === undefined ? "en" : body.language;
    if (language !== "en") {
      return reply.code(400).send({ error: 'Only language "en" is supported.' });
    }
    const modeRaw = body.mode === undefined ? "hot_seat" : body.mode;
    if (modeRaw !== "hot_seat" && modeRaw !== "profile") {
      return reply.code(400).send({ error: 'Mode must be "hot_seat" or "profile".' });
    }
    const durationRaw = body.duration_minutes ?? body.durationMinutes ?? 5;
    if (durationRaw !== 5 && durationRaw !== 10) {
      return reply.code(400).send({ error: "Duration must be 5 or 10 minutes." });
    }
    const mode = modeRaw as "hot_seat" | "profile";
    const durationMinutes = durationRaw as 5 | 10;
    const started = performance.now();
    try {
      const scenario = await generate(description, language, { mode, durationMinutes });
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
        new MetaLlm({ apiKey: config.MODEL_API_KEY, structuredModel: "muse-wonder-1.0", chatTimeoutMs: config.turnLlmTimeoutMs, structuredTimeoutMs: config.debriefTimeoutMs }),
        "muse-wonder-1.0",
        "medium",
        (line) => app.log.info(line),
        config.debriefTimeoutMs,
      );
      return coach.generate(scenario, turns, language);
    });

  const imageGen: ImageGen | null =
    deps.imageGen !== undefined
      ? deps.imageGen
      : config.MODEL_API_KEY
        ? new MetaImageGen({ apiKey: config.MODEL_API_KEY, timeoutMs: config.imageTimeoutMs })
        : null;

  type FrontPageState =
    | { status: "pending"; frontPage: null; step: null; nextStep: null }
    | { status: "ready"; frontPage: FrontPageResult; step: FrontPageStep; nextStep: FrontPageStep | null };
  const frontPages = new Map<string, FrontPageState>();
  type FrontPageContext = {
    debrief: Parameters<typeof generateFrontPage>[1];
    scenario: Parameters<typeof generateFrontPage>[2];
    still: { image: Uint8Array; mimeType: string } | null;
  };
  const frontPageContexts = new Map<string, FrontPageContext>();

  const startFrontPage = (
    sessionId: string,
    debrief: Parameters<typeof generateFrontPage>[1],
    scenario: Parameters<typeof generateFrontPage>[2],
    still: { image: Uint8Array; mimeType: string } | null,
    startStep: FrontPageStep = "edit_full",
  ): void => {
    frontPageContexts.set(sessionId, { debrief, scenario, still });
    if (!imageGen) {
      app.log.info("[front-page] step=html result=ok promptLength=0");
      frontPages.set(sessionId, {
        status: "ready",
        frontPage: buildHtmlFrontPage(debrief, scenario, still),
        step: "html",
        nextStep: null,
      });
      return;
    }
    frontPages.set(sessionId, { status: "pending", frontPage: null, step: null, nextStep: null });
    const imageStarted = performance.now();
    void (async () => {
      const outcome = await generateFrontPage(imageGen, debrief, scenario, still, {
        startStep,
        log: (line) => app.log.info(line),
      });
      const imageMs = Math.round(performance.now() - imageStarted);
      app.log.info(`[front-page] generated in ${imageMs}ms step=${outcome.step}`);
      frontPages.set(sessionId, {
        status: "ready",
        frontPage: outcome.frontPage,
        step: outcome.step,
        nextStep: outcome.nextStep,
      });
    })();
  };

  const newsTts: TextToSpeech | null =
    deps.tts !== undefined
      ? deps.tts
      : config.ELEVENLABS_API_KEY
        ? new ElevenLabsTextToSpeech({ apiKey: config.ELEVENLABS_API_KEY, defaultVoiceId: NEWS_CLIP_VOICE_ID, timeoutMs: config.newsTtsTimeoutMs })
        : null;

  type Still = { image: Uint8Array; mimeType: string };
  const stills = new Map<string, Still>();

  type NewsClipState =
    | { status: "pending" }
    | {
        status: "ready";
        wav: Uint8Array;
        timeline: NewsTimelinePart[];
        soundbiteLocated: boolean;
        reason: string | null;
        buildMs: number;
        studio: { image: Uint8Array; mimeType: string } | null;
        still: Still | null;
        ttsMode?: "browser" | "elevenlabs";
      }
    | { status: "failed"; reason: string };
  const newsClips = new Map<string, NewsClipState>();

  // Studio image: generated once per server start and cached.
  let studioPromise: Promise<{ image: Uint8Array; mimeType: string } | null> | null = null;
  const getStudioImage = (): Promise<{ image: Uint8Array; mimeType: string } | null> => {
    if (!imageGen) return Promise.resolve(null);
    if (!studioPromise) {
      studioPromise = imageGen
        .generateImage(STUDIO_IMAGE_PROMPT)
        .then((r) => {
          app.log.info(
            `[front-page] step=generate_storefront result=ok promptLength=${STUDIO_IMAGE_PROMPT.length} surface=news_studio`,
          );
          return { image: r.image, mimeType: r.mimeType };
        })
        .catch((err: unknown) => {
          app.log.info(
            `[front-page] step=generate_storefront result=${classifyImageError(err)} promptLength=${STUDIO_IMAGE_PROMPT.length} surface=news_studio`,
          );
          app.log.info(`[front-page] step=html result=ok promptLength=0 surface=news_studio`);
          return null;
        });
    }
    return studioPromise;
  };

  const startNewsClip = (
    sessionId: string,
    debrief: Parameters<typeof generateFrontPage>[1],
    turns: Parameters<DebriefGenerator>[1],
    still: Still | null,
  ): void => {
    const news = debrief.news;
    if (!news) return;
    if (newsClips.has(sessionId)) return;
    if (still) stills.set(sessionId, still);
    const browserClip = config.ttsProvider === "browser" && deps.tts === undefined;
    if (!browserClip && !newsTts) {
      newsClips.set(sessionId, { status: "failed", reason: "news TTS is not configured" });
      app.log.info("[news-clip] skipped: TTS is not configured");
      return;
    }
    newsClips.set(sessionId, { status: "pending" });
    const started = performance.now();
    void (async () => {
      try {
        const buffer = ownerAudioRegistry.get(sessionId);
        const [built, studio] = await Promise.all([
          browserClip
            ? Promise.resolve(buildBrowserNewsClip({ news, buffer, turns, log: (line) => app.log.info(line) }))
            : buildNewsClipAudio({
                news,
                buffer,
                turns,
                tts: newsTts!,
                ...(deps.newsVoiceId ? { voiceId: deps.newsVoiceId } : {}),
                log: (line) => app.log.info(line),
              }),
          getStudioImage(),
        ]);
        const buildMs = Math.round(performance.now() - started);
        app.log.info(
          `[news-clip] built in ${buildMs}ms soundbiteLocated=${built.soundbiteLocated}${built.reason ? ` reason=${built.reason}` : ""}`,
        );
        // Keep only the soundbite segment; drop the rest of the recording.
        if (buffer) {
          if (built.soundbiteLocated && built.cut) buffer.trimToSegment(built.cut.startMs, built.cut.endMs);
          else buffer.clear();
        }
        newsClips.set(sessionId, {
          status: "ready",
          wav: built.wav,
          timeline: built.timeline,
          soundbiteLocated: built.soundbiteLocated,
          reason: built.reason,
          buildMs,
          studio,
          still: stills.get(sessionId) ?? still,
          ttsMode: browserClip ? "browser" : "elevenlabs",
        });
      } catch (err) {
        const buildMs = Math.round(performance.now() - started);
        app.log.error(
          `[news-clip] build failed after ${buildMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        newsClips.set(sessionId, {
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

  app.get<{ Params: { id: string } }>("/api/sessions/:id/news-clip", async (request, reply) => {
    const sessionId = request.params.id;
    const record = sessions.get(sessionId);
    if (!record) return reply.code(404).send({ error: "Unknown session." });
    const news = record.debrief?.news;
    if (!news) return reply.code(404).send({ error: "This debrief has no news item." });
    const entry = newsClips.get(sessionId);
    if (!entry) return reply.code(404).send({ error: "News clip has not started building." });
    if (entry.status === "pending") return reply.code(202).send({ status: "building" });
    if (entry.status === "failed") return reply.code(502).send({ error: "News clip could not be built." });
    return {
      audioUrl: `/api/sessions/${sessionId}/news-clip/audio`,
      ttsMode: entry.ttsMode ?? "elevenlabs",
      anchorIntro: news.anchor_intro,
      anchorOutro: news.anchor_outro,
      soundbiteAudioUrl: entry.ttsMode === "browser" ? `/api/sessions/${sessionId}/news-clip/soundbite-audio` : null,
      timeline: entry.timeline,
      studioImageUrl: entry.studio ? `/api/sessions/${sessionId}/news-clip/studio-image` : null,
      studioFallback: !entry.studio,
      channel: news.channel,
      chyron: news.chyron,
      ticker: news.ticker,
      ownerStillUrl: entry.still ? `/api/sessions/${sessionId}/news-clip/owner-still` : null,
      soundbite: news.soundbite,
      soundbiteLocated: entry.soundbiteLocated,
      buildMs: entry.buildMs,
    };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/news-clip/audio", async (request, reply) => {
    const entry = newsClips.get(request.params.id);
    if (!entry || entry.status !== "ready") return reply.code(404).send({ error: "News clip audio is not ready." });
    return reply.type("audio/wav").send(Buffer.from(entry.wav));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/news-clip/soundbite-audio", async (request, reply) => {
    const entry = newsClips.get(request.params.id);
    if (!entry || entry.status !== "ready") return reply.code(404).send({ error: "News clip audio is not ready." });
    return reply.type("audio/wav").send(Buffer.from(entry.wav));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/news-clip/studio-image", async (request, reply) => {
    const entry = newsClips.get(request.params.id);
    if (!entry || entry.status !== "ready" || !entry.studio) {
      return reply.code(404).send({ error: "Studio image is not ready." });
    }
    return reply.type(entry.studio.mimeType).send(Buffer.from(entry.studio.image));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/news-clip/owner-still", async (request, reply) => {
    const entry = newsClips.get(request.params.id);
    const still = (entry && entry.status === "ready" ? entry.still : null) ?? stills.get(request.params.id) ?? null;
    if (!still) return reply.code(404).send({ error: "Owner still is not available." });
    return reply.type(still.mimeType).send(Buffer.from(still.image));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/front-page", async (request, reply) => {
    const sessionId = request.params.id;
    const record = sessions.get(sessionId);
    if (!record) {
      return reply.code(404).send({ error: "Unknown session." });
    }
    const entry = frontPages.get(sessionId);
    if (!entry) {
      if (!record.debrief) {
        return reply.code(404).send({ error: "Front page has not started printing." });
      }
      return { frontPage: null };
    }
    if (entry.status === "pending") {
      return reply.code(202).send({ status: "printing", frontPage: null, step: null, nextStep: null });
    }
    return { frontPage: entry.frontPage, step: entry.step, nextStep: entry.nextStep };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/sessions/:id/front-page/retry", async (request, reply) => {
    const sessionId = request.params.id;
    const record = sessions.get(sessionId);
    if (!record) return reply.code(404).send({ error: "Unknown session." });
    const ctx = frontPageContexts.get(sessionId);
    if (!ctx) return reply.code(404).send({ error: "Front page has not started printing." });
    const body = (request.body ?? {}) as { startStep?: unknown; step?: unknown };
    const requested = body.startStep ?? body.step;
    const current = frontPages.get(sessionId);
    const fallbackStep: FrontPageStep =
      current?.status === "ready" ? (current.nextStep ?? "html") : "edit_full";
    const startStep: FrontPageStep =
      typeof requested === "string" && (FRONT_PAGE_STEPS as readonly string[]).includes(requested)
        ? (requested as FrontPageStep)
        : fallbackStep;
    startFrontPage(sessionId, ctx.debrief, ctx.scenario, ctx.still, startStep);
    return reply.code(202).send({ status: "printing", frontPage: null, step: null, nextStep: null });
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/sessions/:id/debrief",
    { bodyLimit: MAX_STILL_BYTES * 2 },
    async (request, reply) => {
      const sessionId = request.params.id;
      const record = sessions.get(sessionId);
      if (!record) {
        return reply.code(404).send({ error: "Unknown session." });
      }
      // One debrief per session: a repeat call returns the stored one.
      if (record.debrief) {
        startNewsClip(sessionId, record.debrief, record.turns, null);
        const cached: DebriefResponse = { debrief: record.debrief, frontPage: null };
        return cached;
      }
      const scenario = record.scenario;
      const turns = record.turns;
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

      // Start the image as soon as the debrief JSON exists, but return the
      // debrief now: the client fetches the image from the front-page route.
      startFrontPage(sessionId, debrief, scenario, still);
      // Built in parallel with the front page.
      startNewsClip(sessionId, debrief, turns, still);

      const response: DebriefResponse = { debrief, frontPage: null };
      return response;
    },
  );

  return app;
}
