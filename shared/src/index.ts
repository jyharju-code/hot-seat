import { z } from "zod";

/** Types shared by server and web. */

export type ProviderId = "llm" | "speech-to-text" | "text-to-speech" | "image-gen";

export interface ProviderStatus {
  id: ProviderId;
  /** Short human label, safe to show in the UI. */
  label: string;
  /** Adapter class or service name, no secrets. */
  adapter: string;
  configured: boolean;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}

export interface HealthResponse {
  status: "ok";
  service: "hot-seat-server";
  version: string;
  /** Active TTS path, e.g. browser label. Optional for old servers. */
  tts?: string;
  ttsProvider?: "browser" | "elevenlabs";
}

/** A fictional crisis scenario built before a rehearsal starts. */
export interface Scenario {
  id: string;
  title: string;
  /** What has supposedly happened, in plain words. */
  brief: string;
  businessName: string;
  businessDescription: string;
  crisisDescription: string;
  reporterNames: string[];
  facts: string[];
  createdAt: string;
}

/** Events exchanged during a live session (shape only in this brief). */
export type SessionEvent =
  | { type: "session.started"; sessionId: string; scenarioId: string; at: string }
  | { type: "reporter.question"; sessionId: string; reporter: string; text: string; at: string }
  | { type: "user.transcript"; sessionId: string; text: string; isFinal: boolean; at: string }
  | { type: "reporter.interruption"; sessionId: string; reporter: string; text: string; reason: string; at: string }
  | { type: "session.ended"; sessionId: string; at: string }
  | { type: "debrief.ready"; sessionId: string; headline: string; at: string };

export type SessionEventType = SessionEvent["type"];

// ---------------------------------------------------------------------------
// Live voice session protocol over /ws (Brief 02)
// Binary frames: client to server PCM16 16 kHz, server to client PCM 24 kHz.
// JSON text frames use the schemas below on both sides.
// ---------------------------------------------------------------------------

export const reporterMoveSchema = z.enum(["follow_up", "new_angle", "confront", "pass"]);
export type ReporterMove = z.infer<typeof reporterMoveSchema>;

export const reporterFlagSchema = z.enum([
  "dodge",
  "contradiction",
  "speculation",
  "blame_shifting",
  "empathy_missing",
  "strong_answer",
]);
export type ReporterFlag = z.infer<typeof reporterFlagSchema>;

export const reporterLineSchema = z.object({
  move: reporterMoveSchema,
  flags: z.array(reporterFlagSchema),
  say: z.string().min(1),
  quote_used: z.string().nullable(),
  /** Semantic end-of-turn judgement for the owner answer this replies to. */
  owner_done: z.boolean().optional(),
  /** Profile mode only, hidden from UI: owner's exact words worth printing, or null. */
  quote_harvest: z.string().nullable().optional(),
  /** Profile mode only, hidden from UI: story angle the reporter is quietly building. */
  angle: z.string().nullable().optional(),
});
export type ReporterLine = z.infer<typeof reporterLineSchema>;

/** Gentle client notice for a recovered connection failure (not a raw provider error). */
export const CONNECTION_HICCUP_MESSAGE = "Connection hiccup, carrying on.";

export const sessionStateSchema = z.enum(["listening", "thinking", "speaking"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const ttsProviderSchema = z.enum(["browser", "elevenlabs"]);
export type TtsProvider = z.infer<typeof ttsProviderSchema>;

export const voiceRoleSchema = z.enum(["reporter", "radio", "anchor"]);
export type VoiceRoleHint = z.infer<typeof voiceRoleSchema>;

export const voiceHintSchema = z.object({
  role: voiceRoleSchema,
  temperament: z.enum(["relentless", "precise", "human"]).optional(),
  gender: z.enum(["female", "male"]).optional(),
});
export type VoiceHint = z.infer<typeof voiceHintSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    scenarioId: z.string().min(1),
    /** Multiplier for escalation at_seconds. Honoured only outside production. */
    escalationScale: z.number().positive().finite().optional(),
  }),
  z.object({ type: z.literal("playback_done") }),
  z.object({ type: z.literal("speech_started"), speechStartMs: z.number().nonnegative().optional() }),
  z.object({ type: z.literal("stop") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const turnTimingSchema = z.object({
  turn: z.number().int().nonnegative(),
  /** ms from the user's speech end (speechEnd) to the final transcript. */
  speechEndToFinalMs: z.number().nonnegative(),
  /** ms from speech end to the LLM response (first token proxy: non-streaming chat). */
  speechEndToLlmMs: z.number().nonnegative(),
  /** ms from speech end to the first TTS audio byte. */
  speechEndToFirstAudioMs: z.number().nonnegative(),
  /** Total ms from speech end to first audio (same origin as the fields above). */
  totalToFirstAudioMs: z.number().nonnegative(),
  /** True when TTS audio was buffered speculatively before the turn ended. */
  speculativeTtsUsed: z.boolean().default(false),
  /** True when the used speculative turn call started from a stable partial. */
  partialStartUsed: z.boolean().default(false),
  /** Provider that won the turn race, or null when not raced. */
  raceWinner: z.enum(["meta", "baseten"]).nullable().default(null),
  /** Client-reported ms from line sent to first speech sound (browser TTS). */
  speechStartMs: z.number().nonnegative().optional(),
});
export type TurnTiming = z.infer<typeof turnTimingSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_started"), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("ended"), message: z.string() }),
  z.object({ type: z.literal("state"), state: sessionStateSchema }),
  z.object({
    type: z.literal("transcript"),
    role: z.enum(["user", "reporter", "news"]),
    text: z.string(),
  }),
  z.object({ type: z.literal("news_flash"), text: z.string(), atSeconds: z.number().nonnegative(), voiceHint: voiceHintSchema.optional() }),
  z.object({ type: z.literal("interrupt"), say: z.string(), voiceHint: voiceHintSchema.optional() }),
  z.object({ type: z.literal("reporter_line"), line: reporterLineSchema, voiceHint: voiceHintSchema.optional() }),
  z.object({ type: z.literal("session_complete"), message: z.string(), voiceHint: voiceHintSchema.optional() }),
  z.object({ type: z.literal("audio_end") }),
  z.object({ type: z.literal("timing"), timing: turnTimingSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Generated crisis scenarios (Brief 03, Crisis Director)
// ---------------------------------------------------------------------------

export const temperamentSchema = z.enum(["relentless", "precise", "human"]);
export type Temperament = z.infer<typeof temperamentSchema>;

export const landmineSchema = z.object({
  id: z.string().min(1),
  fact: z.string().min(1),
  who_knows: z.string().min(1),
  reveal_after_seconds: z.number().nonnegative(),
  /** True when the owner already knows this fact (but the press does not, yet). Default keeps stored scenarios loading. */
  owner_knows: z.boolean().default(false),
});
export type Landmine = z.infer<typeof landmineSchema>;

export const voiceGenderSchema = z.enum(["female", "male"]);
export type VoiceGender = z.infer<typeof voiceGenderSchema>;

export const journalistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  outlet: z.string().min(1),
  temperament: temperamentSchema,
  voice: voiceGenderSchema.default("male"),
  agenda: z.string().min(1),
  opening_question: z.string().min(1),
});
export type ScenarioJournalist = z.infer<typeof journalistSchema>;

export const escalationSchema = z.object({
  at_seconds: z.number().nonnegative(),
  news_flash: z.string().min(1),
  gives_journalist: z.string().min(1),
  new_fact: z.string().min(1),
});
export type Escalation = z.infer<typeof escalationSchema>;

export const scenarioFormatSchema = z.enum(["interview", "press_conference", "profile"]);
export type ScenarioFormat = z.infer<typeof scenarioFormatSchema>;
export const durationMinutesSchema = z.union([z.literal(5), z.literal(10)]);
export type DurationMinutes = z.infer<typeof durationMinutesSchema>;

export const generatedScenarioSchema = z.object({
  format: scenarioFormatSchema,
  /** Profile session length. Defaults to 5 so old stored scenarios still load. */
  duration_minutes: durationMinutesSchema.default(5),
  fictionalized_from: z.string().nullable(),
  company: z.object({
    name: z.string().min(1),
    industry: z.string().min(1),
    city: z.string().min(1),
    size: z.string().min(1),
  }),
  spokesperson_role: z.string().min(1),
  crisis: z.object({
    headline: z.string().min(1),
    summary: z.string().min(1),
    timeline: z.array(z.string().min(1)).min(1),
    stakes: z.string().min(1),
  }),
  briefing_for_user: z.array(z.string().min(1)).min(1),
  public_facts: z.array(z.string().min(1)).min(1),
  landmines: z.array(landmineSchema).min(1),
  journalists: z.array(journalistSchema).min(1),
  escalations: z.array(escalationSchema),
  good_answer_shape: z.string().min(1),
});
export type GeneratedScenario = z.infer<typeof generatedScenarioSchema>;

export interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  /** Which rehearsal this preset belongs to. Absent means hot seat (crisis). */
  mode?: "hot_seat" | "profile";
}

export function isProfileScenario(scenario: GeneratedScenario): boolean {
  return scenario.format === "profile";
}

/** Planned session length in seconds (profile: duration_minutes; crisis: no fixed length). */
export function sessionDurationSeconds(scenario: GeneratedScenario): number {
  return isProfileScenario(scenario) ? scenario.duration_minutes * 60 : 0;
}

export const PROFILE_WRAP_UP_SECONDS = 45;

/** Profile pacing phase for an elapsed time. */
export function profilePhase(
  elapsedSeconds: number,
  durationSeconds: number,
): "running" | "wrapping_up" | "complete" {
  if (durationSeconds <= 0) return "running";
  if (elapsedSeconds >= durationSeconds) return "complete";
  if (elapsedSeconds >= durationSeconds - PROFILE_WRAP_UP_SECONDS) return "wrapping_up";
  return "running";
}

export function shouldWrapUp(elapsedSeconds: number, durationSeconds: number): boolean {
  return profilePhase(elapsedSeconds, durationSeconds) === "wrapping_up";
}

export function isSessionComplete(elapsedSeconds: number, durationSeconds: number): boolean {
  return profilePhase(elapsedSeconds, durationSeconds) === "complete";
}

export const PROFILE_WRAP_UP_LINE = "We're nearly out of time, one last question: what are you proudest of in all these years?";
export const PROFILE_COMPLETE_MESSAGE = "Thank you so much, that was a pleasure. That is everything I need for the feature.";
export const PROFILE_CUT_IN_MESSAGE = "I'm so sorry to stop you there, we're out of time. Thank you, this was lovely.";

/** True for the deterministic profile wrap-up line (or the prompt's variant). */
export function isWrapUpLine(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("nearly out of time") && t.includes("one last question");
}

export interface CreateScenarioResponse {
  id: string;
  scenario: GeneratedScenario;
}

/** Landmines the owner already knows (shown in the briefing). The surprise landmine is excluded. */
export function ownerKnownLandmines(scenario: GeneratedScenario): Landmine[] {
  return scenario.landmines.filter((m) => m.owner_knows);
}

/** Landmines this journalist knows at `elapsedSeconds` into the session. */
export function revealedLandmines(
  scenario: GeneratedScenario,
  journalistId: string,
  elapsedSeconds: number,
): Landmine[] {
  return scenario.landmines.filter(
    (m) => m.who_knows === journalistId && m.reveal_after_seconds <= elapsedSeconds,
  );
}

// ---------------------------------------------------------------------------
// Debrief and front page (Brief 05)
// ---------------------------------------------------------------------------

const score = z.number().min(0).max(100);

export const debriefLandmineStatusSchema = z.enum([
  "disclosed_proactively",
  "raised_and_handled",
  "raised_and_fumbled",
  "not_raised",
]);
export type DebriefLandmineStatus = z.infer<typeof debriefLandmineStatusSchema>;

/**
 * Landmine outcome in a debrief. The new shape is `{id, status, comment}`.
 * Stored debriefs with the old `{id, handled: boolean, comment}` shape still
 * parse: `handled: true` maps to `raised_and_handled`, `false` to
 * `raised_and_fumbled`.
 */
export const debriefLandmineSchema = z
  .object({
    id: z.string().min(1),
    status: debriefLandmineStatusSchema.optional(),
    handled: z.boolean().optional(),
    comment: z.string(),
  })
  .refine((m) => m.status !== undefined || m.handled !== undefined, {
    message: "landmine needs status or handled",
  })
  .transform((m) => ({
    id: m.id,
    status: m.status ?? (m.handled ? "raised_and_handled" : "raised_and_fumbled"),
    comment: m.comment,
  }));
export type DebriefLandmine = z.infer<typeof debriefLandmineSchema>;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
const maxWords = (max: number) => (text: string) => wordCount(text) <= max;

/** Evening news item for the debrief (Brief 14). Old debriefs omit it. */
export const debriefNewsSchema = z.object({
  soundbite: z
    .string()
    .min(1)
    .refine((t) => wordCount(t) >= 4 && wordCount(t) <= 15, {
      message: "soundbite must be 4 to 15 words",
    }),
  /** 1-based owner turn the soundbite came from (first owner answer is 1). */
  soundbite_turn: z.number().int().min(1),
  channel: z.string().min(1),
  anchor_intro: z.string().min(1).refine(maxWords(35), { message: "anchor_intro must be at most 35 words" }),
  anchor_outro: z.string().min(1).refine(maxWords(20), { message: "anchor_outro must be at most 20 words" }),
  chyron: z.string().min(1).refine(maxWords(8), { message: "chyron must be at most 8 words" }),
  ticker: z.array(z.string().min(1)).length(3),
});
export type DebriefNews = z.infer<typeof debriefNewsSchema>;

export interface NewsTimelinePart {
  part: "intro" | "soundbite" | "outro";
  startMs: number;
  endMs: number;
  text: string;
}

/** Response of GET /api/sessions/:sessionId/news-clip when ready. */
export interface NewsClipResponse {
  audioUrl: string;
  /** Browser mode: no anchor audio; player speaks anchor lines. */
  ttsMode?: "browser" | "elevenlabs";
  anchorIntro?: string;
  anchorOutro?: string;
  /** Browser mode: WAV containing only the owner's soundbite. */
  soundbiteAudioUrl?: string | null;
  timeline: NewsTimelinePart[];
  studioImageUrl: string | null;
  /** True when the studio image failed and the client shows a plain CSS studio. */
  studioFallback?: boolean;
  channel: string;
  chyron: string;
  ticker: string[];
  ownerStillUrl: string | null;
  soundbite: string;
  soundbiteLocated: boolean;
}

export const debriefSchema = z.object({
  scores: z.object({
    clarity: score,
    accountability: score,
    composure: score,
    message_discipline: score,
    empathy: score,
  }),
  verdict: z.string().min(1),
  best_moments: z.array(z.object({ t: z.string(), quote: z.string(), why: z.string() })),
  worst_moments: z.array(
    z.object({
      t: z.string(),
      quote: z.string(),
      why: z.string(),
      better: z.string(),
      /** Optional research principle, e.g. "Stealing thunder [Arpan & Roskos-Ewoldsen 2005]". Old debriefs omit it. */
      principle: z.string().optional(),
    }),
  ),
  headline_quote: z.string(),
  front_page: z.object({ headline: z.string().min(1), subhead: z.string() }),
  landmines: z.array(debriefLandmineSchema),
  /** Profile only: harvested quotes, how the paper frames each, and a safer warm alternative. Old debriefs omit it. */
  gave_away: z
    .array(z.object({ quote: z.string(), framing: z.string(), better: z.string() }))
    .optional(),
  /** Evening news item (Brief 14). Old debriefs omit it and show no clip. */
  news: debriefNewsSchema.optional(),
  one_thing_to_practice: z.string(),
});
export type Debrief = z.infer<typeof debriefSchema>;

export const FRONT_PAGE_STEPS = ["edit_full", "edit_minimal", "generate_storefront", "html"] as const;
export type FrontPageStep = (typeof FRONT_PAGE_STEPS)[number];

/** The step after `step` in the fallback ladder, or null at the last step. */
export function nextFrontPageStep(step: FrontPageStep): FrontPageStep | null {
  const i = FRONT_PAGE_STEPS.indexOf(step);
  return i >= 0 && i < FRONT_PAGE_STEPS.length - 1 ? FRONT_PAGE_STEPS[i + 1]! : null;
}

export type FrontPageResult =
  | { kind: "image"; imageBase64: string; mime: string; step: Exclude<FrontPageStep, "html"> }
  | {
      kind: "html";
      step: "html";
      paperName: string;
      date: string;
      headline: string;
      subhead: string;
      companyName: string;
      summary: string;
      keyFacts: string[];
      quotes: string[];
      photoBase64: string | null;
      photoMime: string | null;
      profile: boolean;
    };

export interface DebriefResponse {
  debrief: Debrief;
  frontPage: FrontPageResult | null;
}

/** Format elapsed seconds as mm:ss from session start. */
export function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Estimated spoken duration at about 2.6 words per second (sim / browser timing). */
export function estimatedSpeechMs(text: string): number {
  const words = stripAudioTags(text).split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.6) * 1000);
}

/** Small rate/pitch tweak for a leading audio tag, for browser speech. */
export function tagProsody(text: string): { rate: number; pitch: number } {
  const m = /\[([^\]]+)\]/.exec(text);
  const tag = (m?.[1] ?? "").toLowerCase();
  if (/sharp|impatient|pressing|urgent/.test(tag)) return { rate: 1.08, pitch: 1.05 };
  if (/warm|calm|soft|gentle/.test(tag)) return { rate: 0.94, pitch: 0.95 };
  if (/hesitat|pause|sigh/.test(tag)) return { rate: 0.9, pitch: 0.95 };
  return { rate: 1, pitch: 1 };
}

/** Strip ElevenLabs audio tags (e.g. `[sharply]`) for display. TTS keeps the raw text. */
export function stripAudioTags(text: string): string {
  return text
    .replace(/\[[^\]\n]*\]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}
