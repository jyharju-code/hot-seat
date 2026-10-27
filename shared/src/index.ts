/** Types shared by server and web. Keep this module dependency free. */

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
