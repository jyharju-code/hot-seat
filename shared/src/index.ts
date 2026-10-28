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
});
export type ReporterLine = z.infer<typeof reporterLineSchema>;

export const sessionStateSchema = z.enum(["listening", "thinking", "speaking"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    scenarioId: z.string().min(1),
    /** Multiplier for escalation at_seconds. Honoured only outside production. */
    escalationScale: z.number().positive().finite().optional(),
  }),
  z.object({ type: z.literal("playback_done") }),
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
  z.object({ type: z.literal("news_flash"), text: z.string(), atSeconds: z.number().nonnegative() }),
  z.object({ type: z.literal("interrupt"), say: z.string() }),
  z.object({ type: z.literal("reporter_line"), line: reporterLineSchema }),
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

export const generatedScenarioSchema = z.object({
  format: z.enum(["interview", "press_conference"]),
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
}

export interface CreateScenarioResponse {
  id: string;
  scenario: GeneratedScenario;
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
    z.object({ t: z.string(), quote: z.string(), why: z.string(), better: z.string() }),
  ),
  headline_quote: z.string(),
  front_page: z.object({ headline: z.string().min(1), subhead: z.string() }),
  landmines: z.array(z.object({ id: z.string(), handled: z.boolean(), comment: z.string() })),
  one_thing_to_practice: z.string(),
});
export type Debrief = z.infer<typeof debriefSchema>;

export interface FrontPageResult {
  imageBase64: string;
  mime: string;
}

export interface DebriefResponse {
  debrief: Debrief;
  frontPage: FrontPageResult | null;
}

/** Format elapsed seconds as mm:ss from session start. */
export function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Strip ElevenLabs audio tags (e.g. `[sharply]`) for display. TTS keeps the raw text. */
export function stripAudioTags(text: string): string {
  return text
    .replace(/\[[^\]\n]*\]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}
