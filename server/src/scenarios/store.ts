import { randomUUID } from "node:crypto";
import { generatedScenarioSchema, type GeneratedScenario } from "@hot-seat/shared";
import { dataDirFromEnv, FileStore, type Store } from "../store.js";

export type ScenarioStoreOptions = string | { dataDir?: string; dir?: string; store?: Store<GeneratedScenario> };

/** Scenario store backed by JSON files under DATA_DIR (in-memory cache in front). */
export class ScenarioStore {
  private readonly backing: Store<GeneratedScenario>;
  private count = 0;

  constructor(options?: ScenarioStoreOptions) {
    if (options && typeof options === "object" && options.store) {
      this.backing = options.store;
    } else {
      const dir = typeof options === "string" ? options : (options?.dataDir ?? options?.dir ?? dataDirFromEnv());
      this.backing = new FileStore<GeneratedScenario>(dir, generatedScenarioSchema, "scenarios-");
    }
  }

  add(scenario: GeneratedScenario): string {
    const id = randomUUID();
    this.backing.put(id, scenario);
    this.count += 1;
    return id;
  }

  get(id: string): GeneratedScenario | undefined {
    return this.backing.get(id);
  }

  has(id: string): boolean {
    return this.backing.has(id);
  }

  get size(): number {
    return this.count;
  }
}

/** Shared instance used by the HTTP app and the /ws handler. */
export const scenarioStore = new ScenarioStore();

/** Resolve a scenario for a session start, or throw a client-visible error. */
export function requireScenario(store: ScenarioStore, scenarioId: string): GeneratedScenario {
  const scenario = store.get(scenarioId);
  if (!scenario) throw new Error(`Unknown scenarioId: ${scenarioId}`);
  return scenario;
}

export const SCENARIO_EXPIRED_MESSAGE = "This scenario has expired. Build it again.";
