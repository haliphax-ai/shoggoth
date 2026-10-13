import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { loadLayeredConfigAsync, LAYOUT, VERSION } from "@shoggoth/shared";

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

function printDecisionHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth decision evaluate [--model <provider/model>] --state <state> --questions <json> [--timeout <ms>]
  shoggoth decision models    List configured decision models

--model      Optional, in provider-id/model-name format (e.g. typesafe-main/jev-latest).
             Falls back to the configured decision defaultModel.
--state      A plain string, or JSON (object/array) when valid JSON.
--questions  JSON map of typed questions (noul | choice | score), e.g.
             '{"is_urgent":{"type":"noul","instructions":"Is this urgent?"}}'`);
}

// ---------------------------------------------------------------------------
// Arg parsers
// ---------------------------------------------------------------------------

type ParseOk<T> = { ok: true; payload: T };
type ParseErr = { ok: false; error: string };

export function parseDecisionEvaluateArgs(args: string[]):
  | ParseOk<{
      model?: string;
      state: unknown;
      questions: Record<string, unknown>;
      timeout_ms?: number;
    }>
  | ParseErr {
  let model: string | undefined;
  let state: string | undefined;
  let questionsRaw: string | undefined;
  let timeout_ms: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") {
      const v = args[++i];
      if (!v) return { ok: false, error: "--model must not be empty" };
      model = v;
    } else if (a === "--state") {
      state = args[++i];
    } else if (a === "--questions") {
      questionsRaw = args[++i];
    } else if (a === "--timeout") {
      const raw = args[++i];
      timeout_ms = Number(raw);
      if (!raw || !Number.isFinite(timeout_ms)) {
        return { ok: false, error: `--timeout must be a number, got "${raw}"` };
      }
    }
  }

  if (state === undefined) return { ok: false, error: "--state is required" };
  if (!questionsRaw) return { ok: false, error: "--questions is required" };

  let questions: unknown;
  try {
    questions = JSON.parse(questionsRaw);
  } catch {
    return { ok: false, error: "--questions must be valid JSON" };
  }
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return {
      ok: false,
      error: "--questions must be a JSON object mapping question ids to questions",
    };
  }

  // State may be plain text or structured JSON (object/array)
  let parsedState: unknown = state;
  try {
    const asJson = JSON.parse(state);
    if (asJson !== null && typeof asJson === "object") {
      parsedState = asJson;
    }
  } catch {
    // Not JSON — plain string state
  }

  const payload: {
    model?: string;
    state: unknown;
    questions: Record<string, unknown>;
    timeout_ms?: number;
  } = { state: parsedState, questions: questions as Record<string, unknown> };
  if (model) payload.model = model;
  if (timeout_ms != null) payload.timeout_ms = timeout_ms;
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runDecisionCli(argv: string[]): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

  // Feature gating: with no decision provider that has models, the command is
  // inert on every subcommand (including help) — the feature does not exist.
  const config = await loadLayeredConfigAsync(configDir);
  const decisionEnabled = (config.decision?.providers ?? []).some(
    (p: { models?: unknown[] }) => (p.models?.length ?? 0) > 0,
  );
  if (!decisionEnabled) {
    console.error(
      "shoggoth decision: decision support is not configured (no decision providers with models)",
    );
    process.exitCode = 1;
    return;
  }

  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printDecisionHelp();
    return;
  }

  const sub = argv[0];

  if (sub === "models") {
    const providers = config.decision?.providers ?? [];
    const lines: string[] = [];
    const defaultModel = (config.decision as { defaultModel?: string } | undefined)?.defaultModel;
    for (const provider of providers) {
      const p = provider as {
        id: string;
        kind: string;
        models?: { name: string }[];
      };
      for (const model of p.models ?? []) {
        const ref = `${p.id}/${model.name}`;
        const marker = ref === defaultModel ? "  (default)" : "";
        lines.push(`${ref}${marker}  →  ${p.kind}`);
      }
    }
    console.log(lines.join("\n"));
    return;
  }

  // --- evaluate ---
  if (sub === "evaluate") {
    const parsed = parseDecisionEvaluateArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      console.error(
        "usage: shoggoth decision evaluate [--model <provider/model>] --state <state> --questions <json> [--timeout <ms>]",
      );
      process.exitCode = 1;
      return;
    }

    const socketPath = await socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "decision_evaluate",
      payload: parsed.payload,
    });

    if (!res.ok) {
      console.error(JSON.stringify(res, null, 2));
      process.exitCode = 1;
      return;
    }

    const result = (res as Record<string, unknown>).result as Record<string, unknown> | undefined;
    if (result) {
      if (result.status === "error") {
        console.error(`Error: ${result.error}`);
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
    return;
  }

  // --- unknown ---
  printDecisionHelp();
  process.exitCode = 1;
}
