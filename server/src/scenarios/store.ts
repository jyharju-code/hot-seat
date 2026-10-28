import { randomUUID } from "node:crypto";
import type { GeneratedScenario } from "@hot-seat/shared";

/** In-memory scenario store. Scenarios live only for this server process. */
export class ScenarioStore {
  private readonly map = new Map<string, GeneratedScenario>();

  add(scenario: GeneratedScenario): string {
    const id = randomUUID();
    this.map.set(id, scenario);
    return id;
  }

  get(id: string): GeneratedScenario | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
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
