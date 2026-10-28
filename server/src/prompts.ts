import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prompts");

/** Load a prompt Markdown file from prompts/ at runtime. Never hard-code prompts in TypeScript. */
export async function loadPrompt(name: string): Promise<string> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe.endsWith(".md")) throw new Error(`Prompt name must end in .md: ${name}`);
  return readFile(path.join(promptsDir, safe), "utf8");
}

/** Fill {placeholders} in a prompt template. No library, unknown keys stay as-is. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}
