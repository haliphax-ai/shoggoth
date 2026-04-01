import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

export const REQUIRED_PROMPT_KEYS: readonly string[] = [
  "mcp-no-client-stub",
  "session-segment-startup-new",
  "session-segment-startup-reset",
  "system-cli-docs",
  "system-env-session-appendix",
  "system-heartbeats",
  "system-identity",
  "system-memory-hint",
  "system-project-context-title",
  "system-project-operator-block",
  "system-project-workspace-intro",
  "system-runtime",
  "system-safety",
  "system-silent-replies-default",
  "system-silent-replies-platform",
  "system-soul-guidance",
  "system-tooling",
  "system-workspace-files-heading",
  "system-workspace-none",
  "system-workspace-root",
] as const;

let cache: Map<string, string> | undefined;

/** Load all `*.md` in this directory (call once from daemon startup). Idempotent. */
export function loadDaemonPrompts(): void {
  if (cache) return;
  cache = new Map();
  for (const name of readdirSync(PROMPTS_DIR)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const key = name.slice(0, -".md".length);
    const text = readFileSync(join(PROMPTS_DIR, name), "utf8").replace(/\r\n/g, "\n").trim();
    cache.set(key, text);
  }
  const missing = REQUIRED_PROMPT_KEYS.filter((k) => !cache!.get(k));
  if (missing.length) {
    throw new Error(`Missing or empty daemon prompts at startup: ${missing.join(", ")}`);
  }
}

function promptText(key: string): string {
  if (!cache) loadDaemonPrompts();
  const s = cache!.get(key);
  if (s === undefined) {
    throw new Error(`missing daemon prompt "${key}.md" under prompts/`);
  }
  return s;
}

/** Replace `{{name}}` placeholders; missing keys become empty string. */
export function fillPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function daemonPrompt(key: string, vars: Record<string, string> = {}): string {
  return fillPromptTemplate(promptText(key), vars);
}
