import {
  debriefSchema,
  formatMmSs,
  generatedScenarioSchema,
  reporterFlagSchema,
  type Debrief,
  type GeneratedScenario,
  type ReporterFlag,
} from "@hot-seat/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dataDirFromEnv, FileStore, type Store } from "../store.js";

export interface TimedTurn {
  role: "user" | "reporter" | "news";
  text: string;
  /** Seconds from session start. */
  elapsedSeconds: number;
  /** Reporter flags judging this turn (user turns) or the reporter's own move. */
  flags: ReporterFlag[];
  /** Set on a cut-off owner turn: why the reporter interrupted. */
  interruptReason?: string;
  /** Profile reporter turn only, hidden from UI: harvested quote from the owner's previous answer. */
  quoteHarvest?: string | null;
  /** Profile reporter turn only, hidden from UI: angle the reporter is building. */
  angle?: string | null;
}

export const timedTurnSchema = z.object({
  role: z.enum(["user", "reporter", "news"]),
  text: z.string(),
  elapsedSeconds: z.number().nonnegative(),
  flags: z.array(reporterFlagSchema),
  interruptReason: z.string().optional(),
  quoteHarvest: z.string().nullable().optional(),
  angle: z.string().nullable().optional(),
});

export interface SessionRecord {
  /** Per-session id issued on start. Key for POST /api/sessions/:sessionId/debrief. */
  id: string;
  /** Scenario this session ran (kept for older records that lack it in queries). */
  scenarioId?: string;
  scenario: GeneratedScenario;
  startedAtMs: number;
  turns: TimedTurn[];
  /** Filled once a debrief has been generated for this finished session. */
  debrief?: Debrief;
}

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1).optional(),
  scenario: generatedScenarioSchema,
  startedAtMs: z.number(),
  turns: z.array(timedTurnSchema),
  debrief: debriefSchema.optional(),
});

export type SessionStoreOptions = string | { dataDir?: string; dir?: string; store?: Store<SessionRecord> };

/** Session transcripts backed by JSON files under DATA_DIR (cache in front). */
export class SessionStore {
  private readonly backing: Store<SessionRecord>;
  private readonly cache = new Map<string, SessionRecord>();

  constructor(options?: SessionStoreOptions) {
    if (options && typeof options === "object" && options.store) {
      this.backing = options.store;
    } else {
      const dir = typeof options === "string" ? options : (options?.dataDir ?? options?.dir ?? dataDirFromEnv());
      this.backing = new FileStore<SessionRecord>(dir, sessionRecordSchema, "sessions-");
    }
  }

  private wrap(record: SessionRecord): SessionRecord {
    const marker = record as SessionRecord & { __persistTurns?: boolean };
    if (marker.__persistTurns) return record;
    Object.defineProperty(record, "__persistTurns", { value: true, enumerable: false });
    const persist = () => {
      try {
        this.backing.put(record.id, record);
      } catch {
        /* persistence is best effort during a live session */
      }
    };
    record.turns = new Proxy(record.turns, {
      set(target, prop, value) {
        const ok = Reflect.set(target, prop, value);
        if (prop === "length" || (typeof prop === "string" && /^\d+$/.test(prop))) persist();
        return ok;
      },
    });
    return record;
  }

  start(id: string, scenario: GeneratedScenario, startedAtMs: number): SessionRecord {
    const record: SessionRecord = { id, scenario, startedAtMs, turns: [] };
    this.wrap(record);
    this.cache.set(id, record);
    this.backing.put(id, record);
    return record;
  }

  /** Start a session with a fresh per-session id (never the scenario id). */
  startSession(scenario: GeneratedScenario, startedAtMs: number, scenarioId?: string): SessionRecord {
    const record: SessionRecord = {
      id: randomUUID(),
      ...(scenarioId ? { scenarioId } : {}),
      scenario,
      startedAtMs,
      turns: [],
    };
    this.wrap(record);
    this.cache.set(record.id, record);
    this.backing.put(record.id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const loaded = this.backing.get(id);
    if (!loaded) return undefined;
    const wrapped = this.wrap(loaded);
    this.cache.set(id, wrapped);
    return wrapped;
  }

  /** Replace a record (used by tests and the smoke script). Persists it. */
  put(record: SessionRecord): void {
    this.wrap(record);
    this.cache.set(record.id, record);
    this.backing.put(record.id, record);
  }

  /** Persist the current state of a record (e.g. a finished session). */
  save(record: SessionRecord): void {
    this.put(record);
  }
}

export const sessionStore = new SessionStore();

/** "[mm:ss] Reporter: ..." / "[mm:ss] Owner: ..." lines for the debrief prompt. */
export function formatTranscript(turns: readonly TimedTurn[]): string {
  if (turns.length === 0) return "(no transcript)";
  return turns
    .map(
      (t) =>
        `[${formatMmSs(t.elapsedSeconds)}] ${t.role === "reporter" ? "Reporter" : t.role === "news" ? "News" : "Owner"}: ${t.text}`,
    )
    .join("\n");
}

/** Harvested quotes collected by the profile reporter, for the debrief prompt. */
export function harvestedQuotes(turns: readonly TimedTurn[]): string[] {
  return turns.flatMap((t) => (t.quoteHarvest ? [t.quoteHarvest] : []));
}

export function formatHarvestedQuotes(turns: readonly TimedTurn[]): string {
  const quotes = harvestedQuotes(turns);
  if (quotes.length === 0) return "(none harvested)";
  return turns
    .flatMap((t) => (t.quoteHarvest ? [`[${formatMmSs(t.elapsedSeconds)}] "${t.quoteHarvest}"${t.angle ? ` (angle: ${t.angle})` : ""}`] : []))
    .join("\n");
}

/** News flashes and one line per flagged user turn, for the {events} prompt slot. */
export function formatEvents(turns: readonly TimedTurn[]): string {
  const lines = turns.flatMap((t) => {
    if (t.interruptReason) return [`[${formatMmSs(t.elapsedSeconds)}] Interrupted: ${t.interruptReason}`];
    if (t.role === "news") return [`[${formatMmSs(t.elapsedSeconds)}] News: ${t.text}`];
    if (t.role === "user" && t.flags.length > 0)
      return [`[${formatMmSs(t.elapsedSeconds)}] Owner flags: ${t.flags.join(", ")}`];
    return [];
  });
  return lines.length > 0 ? lines.join("\n") : "(no flags)";
}
