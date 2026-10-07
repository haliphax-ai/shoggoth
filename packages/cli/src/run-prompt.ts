import { invokeControlRequest, resolveSessionTargetFromCliArg } from "@shoggoth/daemon/lib";
import { loadLayeredConfigAsync, LAYOUT, VERSION } from "@shoggoth/shared";
import { readFileSync } from "node:fs";

function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

async function socketPathFromEnv(configPath: string): Promise<string> {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = await loadLayeredConfigAsync(configPath);
  return config.socketPath;
}

function printPromptHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth prompt <slug> --session <sessionUrn|agentId> [options] [name=value...]

Loads <slug>.md from the workspace (prompts/ or root) or the global prompts
folder, interpolates \${placeholder} values, and delivers the rendered markdown
as an agent turn.

Options:
  --session <urn|agentId>   Target session (required; agentId resolves to its main session)
  --json <blob>             Inline JSON object of placeholder values
  --json-file <path>        Read placeholder values from a JSON file
  --silent                  Internal delivery only (skip messaging surface)

Any other argument is parsed as a placeholder value (name=value).
Sources merge in order: --json-file, --json, then name=value arguments.
Every placeholder in the prompt file must be provided (empty values allowed).`);
}

type ParseOk = {
  ok: true;
  payload: Record<string, unknown>;
  sessionTarget: string;
};
type ParseErr = { ok: false; error: string };

function mergeParams(
  target: Record<string, string>,
  source: Record<string, unknown>,
  origin: string,
): string | null {
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string") {
      target[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      target[k] = String(v);
    } else if (v === null) {
      target[k] = "";
    } else {
      return `${origin}: value for "${k}" must be a string, number, boolean, or null`;
    }
  }
  return null;
}

/** Parse `shoggoth prompt` argv (after the `prompt` token) into a control op payload. */
export function parsePromptArgs(argv: string[]): ParseOk | ParseErr {
  const params: Record<string, string> = {};
  let slug: string | undefined;
  let sessionTarget: string | undefined;
  let silent = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session") {
      const v = argv[++i]?.trim();
      if (!v) return { ok: false, error: "--session requires a value" };
      sessionTarget = v;
    } else if (a === "--json") {
      const raw = argv[++i];
      if (raw === undefined) return { ok: false, error: "--json requires a JSON object" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: `--json must be valid JSON: ${String(e)}` };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "--json must be a JSON object" };
      }
      const err = mergeParams(params, parsed as Record<string, unknown>, "--json");
      if (err) return { ok: false, error: err };
    } else if (a === "--json-file") {
      const path = argv[++i]?.trim();
      if (!path) return { ok: false, error: "--json-file requires a path" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        return { ok: false, error: `--json-file ${path}: ${String(e)}` };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: `--json-file ${path}: must contain a JSON object` };
      }
      const err = mergeParams(params, parsed as Record<string, unknown>, "--json-file");
      if (err) return { ok: false, error: err };
    } else if (a === "--silent") {
      silent = true;
    } else if (a === "--help" || a === "-h") {
      printPromptHelp();
      return { ok: false, error: "" };
    } else if (a.startsWith("-") && !a.includes("=")) {
      return { ok: false, error: `unknown option: ${a}` };
    } else {
      positional.push(a.startsWith("--") ? a.slice(2) : a);
    }
  }

  // First positional is the slug; the rest are placeholder values (name=value).
  slug = positional.shift()?.trim();
  if (!slug) return { ok: false, error: "slug is required" };
  if (!sessionTarget) return { ok: false, error: "--session is required" };
  for (const token of positional) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `expected name=value, got "${token}"` };
    }
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }

  const payload: Record<string, unknown> = { slug, params };
  if (silent) payload.silent = true;
  return { ok: true, payload, sessionTarget: sessionTarget! };
}

export async function runPromptCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printPromptHelp();
    return;
  }
  const parsed = parsePromptArgs(argv);
  if (!parsed.ok) {
    if (parsed.error) {
      console.error(parsed.error);
      console.error("usage: shoggoth prompt <slug> --session <sessionUrn|agentId> [--json <blob>] [--json-file <path>] [name=value...]");
      process.exitCode = 1;
    }
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = await socketPathFromEnv(configDir);
  const auth = controlAuth();

  const config = await loadLayeredConfigAsync(configDir);
  let sessionId: string;
  try {
    sessionId = resolveSessionTargetFromCliArg(parsed.sessionTarget, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  const res = await invokeControlRequest({
    socketPath,
    auth,
    op: "prompt",
    payload: { ...parsed.payload, session_id: sessionId },
  });
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}
