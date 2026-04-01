import {
  invokeControlRequest,
  resolveSessionTargetFromCliArg,
  SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS,
} from "@shoggoth/daemon/lib";
import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";

function controlAuth():
  | { kind: "operator_token"; token: string }
  | { kind: "operator_peercred" } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (token) return { kind: "operator_token", token };
  return { kind: "operator_peercred" };
}

function socketPathFromEnv(configPath: string): string {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = loadLayeredConfig(configPath);
  return config.socketPath;
}

function resolveSessionTargetOrExit(configDir: string, raw: string): string | null {
  const config = loadLayeredConfig(configDir);
  try {
    return resolveSessionTargetFromCliArg(raw, config);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return null;
  }
}

/** Args after `spawn` — pulls `--model-options` / `--model-options=<json>`, returns positional remainder. */
function parseSubagentSpawnArgv(args: string[]): {
  positional: string[];
  modelOptions?: Record<string, unknown>;
  error?: string;
} {
  const positional: string[] = [];
  let modelOptions: Record<string, unknown> | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model-options") {
      const raw = args[++i];
      if (raw === undefined) return { positional: [], error: "missing value for --model-options" };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { positional: [], error: "--model-options must be a JSON object" };
        }
        modelOptions = parsed as Record<string, unknown>;
      } catch {
        return { positional: [], error: "invalid JSON for --model-options" };
      }
      continue;
    }
    if (a.startsWith("--model-options=")) {
      const raw = a.slice("--model-options=".length);
      if (raw === "") return { positional: [], error: "empty value for --model-options=" };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { positional: [], error: "--model-options must be a JSON object" };
        }
        modelOptions = parsed as Record<string, unknown>;
      } catch {
        return { positional: [], error: "invalid JSON for --model-options=" };
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, modelOptions };
}

function printSubagentHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth subagent spawn [--model-options <json>] one_shot <parentUrn|agentId> <prompt...>
  shoggoth subagent spawn [--model-options <json>] persistent <parentUrn|agentId> [threadId] <prompt...>

  one_shot      Internal one-shot child (operator).
  persistent    Persistent child: optional platform thread id for replies; A2A-only when omitted; operator.

  Child inherits parent session model_selection by default; --model-options is a JSON object overlay.

  Env: SHOGGOTH_SUBAGENT_LIFETIME_MS (persistent only, default ${String(SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS)})`);
}

const SPAWN_USAGE =
  "usage: shoggoth subagent spawn [--model-options <json>] one_shot <parentUrn|agentId> <prompt...>\n" +
  "       shoggoth subagent spawn [--model-options <json>] persistent <parentUrn|agentId> [threadId] <prompt...>\n" +
  "       (see: shoggoth subagent --help)\n" +
  "       env: optional SHOGGOTH_SUBAGENT_LIFETIME_MS (persistent only, default " +
  String(SUBAGENT_DEFAULT_PERSISTENT_LIFETIME_MS) +
  ")";

export async function runSubagentCli(argv: string[]): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printSubagentHelp();
    return;
  }

  const sub = argv[0];
  if (sub === "spawn") {
    const { positional, modelOptions, error } = parseSubagentSpawnArgv(argv.slice(1));
    if (error) {
      console.error(error);
      process.exitCode = 1;
      return;
    }
    const mode = positional[0]?.trim();
    const parent = positional[1]?.trim();
    if ((mode !== "one_shot" && mode !== "persistent") || !parent) {
      console.error(SPAWN_USAGE);
      process.exitCode = 1;
      return;
    }
    const parentSessionId = resolveSessionTargetOrExit(configDir, parent);
    if (!parentSessionId) return;

    let payload: Record<string, unknown>;
    if (mode === "one_shot") {
      const prompt = positional.slice(2).join(" ").trim();
      if (!prompt) {
        console.error(
          "usage: shoggoth subagent spawn [--model-options <json>] one_shot <parentUrn|agentId> <prompt...>",
        );
        process.exitCode = 1;
        return;
      }
      payload = { parent_session_id: parentSessionId, prompt, mode: "one_shot" };
    } else {
      // persistent mode: threadId is optional; if the next positional looks like a numeric platform id, treat it as threadId
      const maybeThreadId = positional[2]?.trim();
      let threadId: string | undefined;
      let promptParts: string[];
      // Heuristic: if it's all digits, it's a numeric platform thread id
      if (maybeThreadId && /^\d+$/.test(maybeThreadId)) {
        threadId = maybeThreadId;
        promptParts = positional.slice(3);
      } else {
        promptParts = positional.slice(2);
      }
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error(
          "usage: shoggoth subagent spawn [--model-options <json>] persistent <parentUrn|agentId> [threadId] <prompt...>",
        );
        process.exitCode = 1;
        return;
      }
      const lifetimeRaw = process.env.SHOGGOTH_SUBAGENT_LIFETIME_MS?.trim();
      const lifetimeMs = lifetimeRaw ? Number.parseInt(lifetimeRaw, 10) : undefined;
      payload = {
        parent_session_id: parentSessionId,
        prompt,
        mode: "persistent",
      };
      if (threadId) {
        payload.platform_thread_id = threadId;
      }
      if (lifetimeMs !== undefined && Number.isFinite(lifetimeMs) && lifetimeMs > 0) {
        payload.lifetime_ms = lifetimeMs;
      }
    }
    if (modelOptions !== undefined) {
      payload.model_options = modelOptions;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "subagent_spawn",
      payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  console.error(SPAWN_USAGE);
  process.exitCode = 1;
}
