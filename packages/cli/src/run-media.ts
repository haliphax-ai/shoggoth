import { invokeControlRequest } from "@shoggoth/daemon/lib";
import {
  loadLayeredConfigAsync,
  LAYOUT,
  mediaGenerationModelEntriesFromRecord,
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

function printMediaHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth media generate [--model <model>] --prompt <prompt> [--output <path>] [--param key=value...]
  shoggoth media poll --provider <id> --operation <id> [--output <path>]
  shoggoth media models    List configured media generation models

  --model defaults to the configured mediaGeneration default model for the
  request's media type (params kind); an error is returned when neither is set.`);
}

// ---------------------------------------------------------------------------
// Arg parsers
// ---------------------------------------------------------------------------

type ParseOk<T> = { ok: true; payload: T };
type ParseErr = { ok: false; error: string };

export function parseMediaGenerateArgs(args: string[]):
  | ParseOk<{
      /** Optional — defaults to the configured media-type default model. */
      model?: string;
      prompt: string;
      output_path?: string;
      params?: Record<string, string>;
    }>
  | ParseErr {
  let model: string | undefined;
  let prompt: string | undefined;
  let output_path: string | undefined;
  const params: Record<string, string> = {};
  let hasParams = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") {
      model = args[++i];
    } else if (a === "--prompt") {
      prompt = args[++i];
    } else if (a === "--output") {
      output_path = args[++i];
    } else if (a === "--param") {
      const raw = args[++i];
      if (raw) {
        const eq = raw.indexOf("=");
        if (eq > 0) {
          params[raw.slice(0, eq)] = raw.slice(eq + 1);
        } else {
          return { ok: false, error: `--param must be key=value, got "${raw}"` };
        }
        hasParams = true;
      }
    }
  }

  if (!prompt) return { ok: false, error: "--prompt is required" };

  const payload: {
    model?: string;
    prompt: string;
    output_path?: string;
    params?: Record<string, string>;
  } = { prompt };
  if (model) payload.model = model;
  if (output_path) payload.output_path = output_path;
  if (hasParams) payload.params = params;
  return { ok: true, payload };
}

export function parseMediaPollArgs(args: string[]):
  | ParseOk<{
      provider_id: string;
      operation_id: string;
      output_path?: string;
    }>
  | ParseErr {
  let provider_id: string | undefined;
  let operation_id: string | undefined;
  let output_path: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--provider") {
      provider_id = args[++i];
    } else if (a === "--operation") {
      operation_id = args[++i];
    } else if (a === "--output") {
      output_path = args[++i];
    }
  }

  if (!provider_id) return { ok: false, error: "--provider is required" };
  if (!operation_id) return { ok: false, error: "--operation is required" };

  const payload: {
    provider_id: string;
    operation_id: string;
    output_path?: string;
  } = { provider_id, operation_id };
  if (output_path) payload.output_path = output_path;
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runMediaCli(argv: string[]): Promise<void> {
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printMediaHelp();
    return;
  }

  const sub = argv[0];

  if (sub === "models") {
    const config = await loadLayeredConfigAsync(configDir);
    const providers = Object.entries(config.mediaGeneration?.providers ?? {});
    if (!providers.length) {
      console.log("No media generation providers configured.");
      return;
    }
    const lines: string[] = [];
    for (const [providerId, p] of providers) {
      for (const model of mediaGenerationModelEntriesFromRecord(p.models)) {
        const adapter = model.adapter ?? `${p.kind}/${model.mediaType}`;
        lines.push(`${model.name}  →  ${adapter}  [${providerId}]`);
      }
    }
    console.log(lines.join("\n"));
    return;
  }

  // --- generate ---
  if (sub === "generate") {
    const parsed = parseMediaGenerateArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      console.error(
        "usage: shoggoth media generate [--model <model>] --prompt <prompt> [--output <path>] [--param key=value...]",
      );
      process.exitCode = 1;
      return;
    }

    const socketPath = await socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "media_generate",
      payload: parsed.payload,
    });

    if (!res.ok) {
      console.error(JSON.stringify(res, null, 2));
      process.exitCode = 1;
      return;
    }

    const result = (res as Record<string, unknown>).result as Record<string, unknown> | undefined;
    if (result) {
      if (result.status === "complete") {
        console.log(`Complete: ${result.path} (${result.mime_type})`);
      } else if (result.status === "in_progress") {
        console.log(`In progress — operation: ${result.operation_id}`);
        console.log("Use: shoggoth media poll --provider <id> --operation " + result.operation_id);
      } else if (result.status === "error") {
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

  // --- poll ---
  if (sub === "poll") {
    const parsed = parseMediaPollArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      console.error(
        "usage: shoggoth media poll --provider <id> --operation <id> [--output <path>]",
      );
      process.exitCode = 1;
      return;
    }

    const socketPath = await socketPathFromEnv(configDir);
    const auth = controlAuth();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "media_generate_poll",
      payload: parsed.payload,
    });

    if (!res.ok) {
      console.error(JSON.stringify(res, null, 2));
      process.exitCode = 1;
      return;
    }

    const result = (res as Record<string, unknown>).result as Record<string, unknown> | undefined;
    if (result) {
      if (result.status === "complete") {
        console.log(`Complete: ${result.path} (${result.mime_type})`);
      } else if (result.status === "in_progress") {
        console.log(`Status: in_progress — operation: ${result.operation_id}`);
      } else if (result.status === "error") {
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
  printMediaHelp();
  process.exitCode = 1;
}
