/**
 * Live integration: Anthropic Messages (Kiro) + tool loop + filesystem verify.
 *
 * From `shoggoth/`:
 *   eval "$(node tests/scripts/load-openclaw-env.mjs)"
 *   node --import tsx/esm tests/scripts/kiro-anthropic-tool-verify.ts
 *
 * Env: ANTHROPIC_BASE_URL (origin), ANTHROPIC_API_KEY, SHOGGOTH_MODEL, optional ANTHROPIC_AUTH=bearer,
 * optional VERIFY_WORKSPACE (default: temp dir), OPENCLAW_CONFIG if not using eval.
 */
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createAnthropicMessagesProvider,
  ModelHttpError,
  type ChatMessage,
} from "@shoggoth/models";

function normalizeAnthropicOrigin(raw: string): string {
  const t = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!t) throw new Error("empty ANTHROPIC_BASE_URL");
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return t.replace(/\/v1\/?$/i, "");
  }
}

function loadOpenclawKiro(): { origin: string; apiKey: string; model: string } {
  const p = process.env.OPENCLAW_CONFIG ?? `${homedir()}/.openclaw/openclaw.json`;
  const j = JSON.parse(readFileSync(p, "utf8")) as {
    models?: { providers?: { kiro?: { baseUrl?: string; api?: string; apiKey?: string; models?: { id: string }[] } } } };
  const kiro = j.models?.providers?.kiro;
  if (!kiro?.baseUrl) throw new Error(`no models.providers.kiro.baseUrl in ${p}`);
  if (kiro.api !== "anthropic-messages") {
    throw new Error(`kiro.api must be anthropic-messages (got ${String(kiro.api)})`);
  }
  return {
    origin: normalizeAnthropicOrigin(kiro.baseUrl),
    apiKey: kiro.apiKey ?? "",
    model: kiro.models?.[0]?.id ?? "kiro/auto",
  };
}

function rewriteOriginHost(origin: string, hostPort: string): string {
  const u = new URL(origin);
  const h = hostPort.trim();
  if (!h) return origin;
  const [host, port] = h.includes(":") ? h.split(":") : [h, ""];
  u.hostname = host!;
  if (port) u.port = port;
  return `${u.protocol}//${u.host}`;
}

const writeTool = {
  type: "function" as const,
  function: {
    name: "workspace.write",
    description:
      "Write UTF-8 text to a file path relative to the workspace root. Overwrites if the file exists.",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path, e.g. VERIFY.md" },
        content: { type: "string", description: "Full file body" },
      },
      required: ["path", "content"],
    },
  },
};

async function main(): Promise<void> {
  let origin = process.env.ANTHROPIC_BASE_URL?.trim();
  let apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  let model = process.env.SHOGGOTH_MODEL?.trim();

  if (!origin || !apiKey || !model) {
    const k = loadOpenclawKiro();
    origin = origin || k.origin;
    if (!apiKey) apiKey = k.apiKey;
    model = model || k.model;
  }
  origin = normalizeAnthropicOrigin(origin);
  const hostMap = process.env.SHOGGOTH_KIRO_HTTP_HOST?.trim();
  if (hostMap) origin = rewriteOriginHost(origin, hostMap);

  if (!model) throw new Error("SHOGGOTH_MODEL unset and no model in openclaw kiro");

  const auth = process.env.ANTHROPIC_AUTH?.trim().toLowerCase() === "bearer" ? "bearer" : undefined;

  const workspace =
    process.env.VERIFY_WORKSPACE?.trim() ||
    mkdtempSync(join(tmpdir(), "kiro-anthropic-verify-"));
  mkdirSync(workspace, { recursive: true });

  const provider = createAnthropicMessagesProvider({
    id: "kiro-live-verify",
    baseUrl: origin,
    apiKey: apiKey || undefined,
    auth,
  });

  const userPrompt =
    "You must call the workspace.write tool exactly once. " +
    "Write relative path VERIFY.md with file content exactly: done (three letters, no newline, no quotes). " +
    "After the tool succeeds, reply with one short sentence confirming VERIFY.md was written.";

  let messages: ChatMessage[] = [{ role: "user", content: userPrompt }];

  console.log(`origin=${origin} model=${model} workspace=${workspace}`);

  for (let round = 0; round < 12; round++) {
    let out;
    try {
      out = await provider.completeWithTools({
        model,
        messages,
        tools: [writeTool],
        maxOutputTokens: 4096,
      });
    } catch (e) {
      if (e instanceof ModelHttpError) {
        console.error(`HTTP ${e.status} ${e.message} body=${e.bodySnippet ?? ""}`);
      }
      throw e;
    }

    if (!out.toolCalls.length) {
      console.log("final assistant text:", out.content ?? "(null)");
      break;
    }

    messages = [
      ...messages,
      {
        role: "assistant",
        content: out.content,
        toolCalls: out.toolCalls,
      },
    ];

    for (const tc of out.toolCalls) {
      let payload: string;
      if (tc.name === "workspace.write") {
        let args: { path?: string; content?: string };
        try {
          args = JSON.parse(tc.arguments) as { path?: string; content?: string };
        } catch {
          payload = JSON.stringify({ error: "invalid JSON arguments" });
          messages.push({ role: "tool", toolCallId: tc.id, content: payload });
          continue;
        }
        const rel = String(args.path ?? "");
        const safe = basename(rel);
        if (safe !== "VERIFY.md") {
          payload = JSON.stringify({
            error: `refused: path must be VERIFY.md (got ${JSON.stringify(rel)})`,
          });
        } else {
          const full = join(workspace, safe);
          writeFileSync(full, String(args.content ?? ""), "utf8");
          payload = JSON.stringify({ ok: true, path: safe, bytesWritten: Buffer.byteLength(String(args.content ?? "")) });
          console.log("tool workspace.write executed:", payload);
        }
      } else {
        payload = JSON.stringify({ error: `unknown tool ${tc.name}` });
      }
      messages.push({ role: "tool", toolCallId: tc.id, content: payload });
    }
  }

  const verifyPath = join(workspace, "VERIFY.md");
  const disk = readFileSync(verifyPath, "utf8");
  if (disk.trim() !== "done") {
    throw new Error(`VERIFY.md expected "done", got ${JSON.stringify(disk)}`);
  }
  console.log("OK: VERIFY.md contains done");
  if (!process.env.VERIFY_WORKSPACE?.trim()) {
    rmSync(workspace, { recursive: true, force: true });
    console.log("cleaned temp workspace");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
