import { formatMmSs, type GeneratedScenario, type ReporterFlag } from "@hot-seat/shared";

export interface TimedTurn {
  role: "user" | "reporter";
  text: string;
  /** Seconds from session start. */
  elapsedSeconds: number;
  /** Reporter flags judging this turn (user turns) or the reporter's own move. */
  flags: ReporterFlag[];
}

export interface SessionRecord {
  /** Key used by POST /api/sessions/:id/debrief (the scenario store id). */
  id: string;
  scenario: GeneratedScenario;
  startedAtMs: number;
  turns: TimedTurn[];
}

/** In-memory session transcripts, keyed by scenario id (latest session wins). */
export class SessionStore {
  private readonly map = new Map<string, SessionRecord>();

  start(id: string, scenario: GeneratedScenario, startedAtMs: number): SessionRecord {
    const record: SessionRecord = { id, scenario, startedAtMs, turns: [] };
    this.map.set(id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.map.get(id);
  }

  /** Replace a record (used by tests and the smoke script). */
  put(record: SessionRecord): void {
    this.map.set(record.id, record);
  }
}

export const sessionStore = new SessionStore();

/** "[mm:ss] Reporter: ..." / "[mm:ss] Owner: ..." lines for the debrief prompt. */
export function formatTranscript(turns: readonly TimedTurn[]): string {
  if (turns.length === 0) return "(no transcript)";
  return turns
    .map((t) => `[${formatMmSs(t.elapsedSeconds)}] ${t.role === "reporter" ? "Reporter" : "Owner"}: ${t.text}`)
    .join("\n");
}

/** One line per flagged user turn, for the {events} prompt slot. */
export function formatEvents(turns: readonly TimedTurn[]): string {
  const lines = turns
    .filter((t) => t.role === "user" && t.flags.length > 0)
    .map((t) => `[${formatMmSs(t.elapsedSeconds)}] Owner flags: ${t.flags.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "(no flags)";
}
