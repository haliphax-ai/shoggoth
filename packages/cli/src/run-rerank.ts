import { invokeControlRequest } from "@shoggoth/daemon/lib";
import {
  loadLayeredConfigAsync,
  LAYOUT,
  rerankModelEntriesFromRecord,
  VERSION,
} from "@shoggoth/shared";

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

function printRerankHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth rerank rank [--model <provider/model>] --query <text> --documents <json> [--top <n>] [--timeout <ms>]
  shoggoth rerank models   List configured rerank models

--model      Optional, in provider-id/model-name format (e.g. openrouter-cohere/cohere-rerank-v3.5).
             Falls back to the configured rerank defaultModel.
--query      The query text used to score document relevance.
--documents  JSON array of document strings, e.g. '["doc one","doc two"]'.
--top        Optional. Return at most this many results.`);
}

// ---------------------------------------------------------------------------
// Arg parsers
// ---------------------------------------------------------------------------

type ParseOk<T> = { ok: true; payload: T };
type ParseErr = { ok: false; error: string };

export function parseRerankRankArgs(args: string[]):
  | ParseErr
  | ParseOk<{
      model?: string;
      query: string;
      documents: string[];
      top_n?: number;
      timeout_ms?: number;
    }> {
  let model: string | undefined;
  let query: string | undefined;
  let documentsRaw: string | undefined;
  let top_n: number | undefined;
  let timeout_ms: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") {
      const v = args[++i];
      if (!v) return { ok: false, error: "--model must not be empty" };
      model = v;
    } else if (a === "--query") {
      query = args[++i];
    } else if (a === "--documents") {
      documentsRaw = args[++i];
    } else if (a === "--top") {
      const raw = args[++i];
      top_n = Number(raw);
      if (!raw || !Number.isFinite(top_n)) {
        return { ok: false, error: `--top must be a number, got "${raw}"` };
      }
    } else if (a === "--timeout") {
      const raw = args[++i];
      timeout_ms = Number(raw);
      if (!raw || !Number.isFinite(timeout_ms)) {
        return { ok: false, error: `--timeout must be a number, got "${raw}"` };
      }
    }
  }

  if (!query || !query.trim()) return { ok: false, error: "--query is required" };
  if (!documentsRaw) return { ok: false, error: "--documents is required" };

  let documents: unknown;
  try {
    documents = JSON.parse(documentsRaw);
  } catch {
    return { ok: false, error: "--documents must be a JSON array of strings" };
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    return { ok: false, error: "--documents must be a non-empty JSON array" };
  }
  if (!documents.every((d) => typeof d === "string" && d.length > 0)) {
    return { ok: false, error: "--documents must contain only non-empty strings" };
  }

  const payload: {
    model?: string;
    query: string;
    documents: string[];
    top_n?: number;
    timeout_ms?: number;
  } = { query, documents: documents as string[] };
  if (model) payload.model = model;
  if (top_n != null) payload.top_n = top_n;
  if (timeout_ms != null) payload.timeout_ms = timeout_ms;
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runRerankCli(argv: string[]): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

  // Feature gating: with no rerank provider that has models, the command is
  // inert on every subcommand (including help) — the feature does not exist.
  const config = await loadLayeredConfigAsync(configDir);
  const rerankEnabled = Object.values(config.rerank?.providers ?? {}).some(
    (p: { models?: Record<string, unknown> }) => Object.keys(p.models ?? {}).length > 0,
  );
  if (!rerankEnabled) {
    console.error(
      "shoggoth rerank: rerank support is not configured (no rerank providers with models)",
    );
    process.exitCode = 1;
    return;
  }

  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printRerankHelp();
    return;
  }

  const sub = argv[0];

  if (sub === "models") {
    const lines: string[] = [];
    const defaultModel = config.rerank?.defaultModel;
    for (const [providerId, p] of Object.entries(config.rerank?.providers ?? {})) {
      for (const model of rerankModelEntriesFromRecord(p.models)) {
        const ref = `${providerId}/${model.name}`;
        const marker = ref === defaultModel ? "  (default)" : "";
        lines.push(`${ref}${marker}  →  ${p.kind}`);
      }
    }
    console.log(lines.join("\n"));
    return;
  }

  // --- rank ---
  if (sub === "rank") {
    const parsed = parseRerankRankArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      console.error(
        "usage: shoggoth rerank rank [--model <provider/model>] --query <text> --documents <json> [--top <n>] [--timeout <ms>]",
      );
      process.exitCode = 1;
      return;
    }

    const socketPath = await socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "rerank_documents",
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
  printRerankHelp();
  process.exitCode = 1;
}
