import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";

export const BUILTIN_MEDIA_MODELS: Record<string, "generateContent" | "predict" | "longRunning"> = {
  "gemini-2.5-flash-image": "generateContent",
  "gemini-3-pro-image-preview": "generateContent",
  "gemini-3.1-flash-image-preview": "generateContent",
  "gemini-2.5-flash-preview-tts": "generateContent",
  "gemini-2.5-pro-preview-tts": "generateContent",
  "gemini-3.1-flash-tts-preview": "generateContent",
  "lyria-3": "generateContent",
  imagen: "predict",
  veo: "longRunning",
};

function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

function socketPathFromEnv(configPath: string): string {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = loadLayeredConfig(configPath);
  return config.socketPath;
}

function printMediaHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth media generate --model <model> --prompt <prompt> --provider <id> [--output <path>] [--param key=value...]
  shoggoth media poll --provider <id> --operation <id> [--output <path>]
  shoggoth media models    List built-in media generation model-to-adapter mappings`);
}

// ---------------------------------------------------------------------------
// Arg parsers
// ---------------------------------------------------------------------------

type ParseOk<T> = { ok: true; payload: T };
type ParseErr = { ok: false; error: string };

export function parseMediaGenerateArgs(args: string[]):
  | ParseOk<{
      model: string;
      prompt: string;
      provider_id: string;
      output_path?: string;
      params?: Record<string, string>;
    }>
  | ParseErr {
  let model: string | undefined;
  let prompt: string | undefined;
  let provider_id: string | undefined;
  let output_path: string | undefined;
  const params: Record<string, string> = {};
  let hasParams = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") {
      model = args[++i];
    } else if (a === "--prompt") {
      prompt = args[++i];
    } else if (a === "--provider") {
      provider_id = args[++i];
    } else if (a === "--output") {
      output_path = args[++i];
    } else if (a === "--param") {
      const raw = args[++i];
      if (raw) {
        const eq = raw.indexOf("=");
        if (eq > 0) {
          params[raw.slice(0, eq)] = raw.slice(eq + 1);
        } else {
          params[raw] = "";
        }
        hasParams = true;
      }
    }
  }

  if (!model) return { ok: false, error: "--model is required" };
  if (!prompt) return { ok: false, error: "--prompt is required" };
  if (!provider_id) return { ok: false, error: "--provider is required" };

  const payload: {
    model: string;
    prompt: string;
    provider_id: string;
    output_path?: string;
    params?: Record<string, string>;
  } = { model, prompt, provider_id };
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

  // --- models (no control socket needed) ---
  if (sub === "models") {
    const config = loadLayeredConfig(configDir);
    const operatorMap = config.mediaGeneration?.modelAdapterMap;
    const merged = operatorMap ? { ...BUILTIN_MEDIA_MODELS, ...operatorMap } : BUILTIN_MEDIA_MODELS;
    const lines: string[] = [];
    for (const [model, adapter] of Object.entries(merged)) {
      const source = BUILTIN_MEDIA_MODELS[model] ? "" : "  (config)";
      lines.push(`${model}  →  ${adapter}${source}`);
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
        "usage: shoggoth media generate --model <model> --prompt <prompt> --provider <id> [--output <path>] [--param key=value...]",
      );
      process.exitCode = 1;
      return;
    }

    const socketPath = socketPathFromEnv(configDir);
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

    const socketPath = socketPathFromEnv(configDir);
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
