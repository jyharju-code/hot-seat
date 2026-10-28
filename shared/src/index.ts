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
});
export type ReporterLine = z.infer<typeof reporterLineSchema>;

export const sessionStateSchema = z.enum(["listening", "thinking", "speaking"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
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
});
export type TurnTiming = z.infer<typeof turnTimingSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), state: sessionStateSchema }),
  z.object({
    type: z.literal("transcript"),
    role: z.enum(["user", "reporter"]),
    text: z.string(),
  }),
  z.object({ type: z.literal("reporter_line"), line: reporterLineSchema }),
  z.object({ type: z.literal("audio_end") }),
  z.object({ type: z.literal("timing"), timing: turnTimingSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
