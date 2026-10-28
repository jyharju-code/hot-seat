import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Tiny persistence port. A database can replace FileStore later. */
export interface Store<T> {
  get(id: string): T | undefined;
  put(id: string, value: T): void;
  has(id: string): boolean;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isSafeId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * JSON files under a directory, one file per id (`<prefix><id>.json`),
 * written atomically (temp file in the same dir, then rename).
 * A small in-memory cache sits in front; reads validate with `schema`
 * and reject (return undefined for) corrupt or invalid files.
 */
export class FileStore<T> implements Store<T> {
  private readonly cache = new Map<string, T>();

  constructor(
    private readonly dir: string,
    private readonly schema: { parse: (value: unknown) => T },
    private readonly prefix = "",
  ) {}

  private fileFor(id: string): string {
    return path.join(this.dir, `${this.prefix}${id}.json`);
  }

  get(id: string): T | undefined {
    if (!isSafeId(id)) return undefined;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = this.schema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
      this.cache.set(id, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  put(id: string, value: T): void {
    if (!isSafeId(id)) throw new Error(`Invalid store id: ${id}`);
    const parsed = this.schema.parse(value);
    this.cache.set(id, parsed);
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(id);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed), "utf8");
    renameSync(tmp, file);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }
}

/** DATA_DIR from env, default ./data. */
export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATA_DIR?.trim();
  return raw ? raw : "./data";
}
