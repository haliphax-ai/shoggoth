import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { ProcessManager, ManagedProcess, ProcessSpec } from "@shoggoth/procman";
import type { JsonSchemaLike } from "./json-schema";
import type { McpSourceCatalog } from "./aggregate";
import type { McpToolDescriptor } from "./mcp-tool";

/** MCP JSON-RPC session over newline-delimited JSON (stdio or TCP with same framing). */
export interface McpJsonRpcSession {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  /** Streamable HTTP may return a Promise so `notifications/initialized` can await 202. */
  readonly notify: (method: string, params?: unknown) => void | Promise<void>;
  readonly close: () => Promise<void>;
}

export interface McpToolListEntry {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Maps one MCP `tools/list` tool entry to a Shoggoth descriptor (JSON Schema for args).
 */
export function mcpToolListEntryToDescriptor(entry: McpToolListEntry): McpToolDescriptor {
  const schema = entry.inputSchema;
  const inputSchema: JsonSchemaLike =
    schema !== undefined && typeof schema === "object" && schema !== null && !Array.isArray(schema)
      ? (schema as JsonSchemaLike)
      : { type: "object", properties: {} };
  return {
    name: entry.name,
    description: entry.description,
    inputSchema,
  };
}

/**
 * Runs MCP `initialize` + `notifications/initialized` (required before many servers accept `tools/list`).
 */
export async function mcpInitializeSession(
  session: McpJsonRpcSession,
  options?: { readonly protocolVersion?: string },
): Promise<void> {
  await session.request("initialize", {
    protocolVersion: options?.protocolVersion ?? "2024-11-05",
    capabilities: {},
    clientInfo: { name: "shoggoth", version: "0.1.0" },
  });
  await Promise.resolve(session.notify("notifications/initialized", {}));
}

/**
 * Collects all pages from `tools/list`.
 */
export async function mcpFetchToolsList(session: McpJsonRpcSession): Promise<McpToolListEntry[]> {
  const out: McpToolListEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params = cursor ? { cursor } : {};
    const raw = await session.request("tools/list", params);
    const obj = asRecord(raw);
    if (!obj) {
      break;
    }
    const tools = obj.tools;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        const tr = asRecord(t);
        if (tr && typeof tr.name === "string") {
          out.push({
            name: tr.name,
            description: typeof tr.description === "string" ? tr.description : undefined,
            inputSchema: tr.inputSchema,
          });
        }
      }
    }
    const next = obj.nextCursor;
    if (typeof next === "string" && next.length > 0) {
      cursor = next;
      continue;
    }
    break;
  }
  return out;
}

/** Builds a {@link McpSourceCatalog} from live `tools/list` entries. */
export function mcpToolsToSourceCatalog(sourceId: string, tools: readonly McpToolListEntry[]): McpSourceCatalog {
  return {
    sourceId,
    tools: tools.map(mcpToolListEntryToDescriptor),
  };
}

/**
 * Invokes MCP `tools/call` and returns the protocol result object (e.g. `content`, `isError`).
 */
export async function mcpInvokeTool(
  session: McpJsonRpcSession,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  return session.request("tools/call", { name, arguments: arguments_ });
}

type Pending = {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
};

function jsonRpcErrorToError(err: unknown): Error {
  const o = asRecord(err);
  if (!o) {
    return new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
  const msg = typeof o.message === "string" ? o.message : JSON.stringify(err);
  const code = o.code;
  const suffix = code !== undefined ? ` (code ${String(code)})` : "";
  return new Error(`${msg}${suffix}`);
}

/**
 * Low-level: newline-delimited JSON-RPC 2.0 over separate readable/writable streams.
 * Supports concurrent requests; ignores JSON-RPC notifications (no `id`).
 */
export function createMcpJsonRpcSession(
  input: Readable,
  output: Writable,
  options?: {
    readonly onReaderError?: (err: unknown) => void;
    readonly onProtocolError?: (err: unknown) => void;
  },
): McpJsonRpcSession {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let buffer = "";
  let closed = false;
  let inputEnded = false;

  function failAll(err: Error): void {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
  }

  function onChunk(chunk: Buffer | string): void {
    if (closed) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line) as unknown;
      } catch (e) {
        options?.onProtocolError?.(e);
        continue;
      }
      const m = asRecord(msg);
      if (!m) continue;
      const idRaw = m.id;
      if (idRaw === undefined || idRaw === null) {
        continue;
      }
      const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
      if (!Number.isFinite(id)) {
        continue;
      }
      const p = pending.get(id);
      if (!p) {
        continue;
      }
      pending.delete(id);
      if (m.error !== undefined) {
        p.reject(jsonRpcErrorToError(m.error));
      } else {
        p.resolve(m.result);
      }
    }
  }

  function onEnd(): void {
    inputEnded = true;
    if (!closed) {
      failAll(new Error("MCP JSON-RPC stream ended"));
    }
  }

  function onErr(err: unknown): void {
    options?.onReaderError?.(err);
    if (!closed) {
      failAll(err instanceof Error ? err : new Error(String(err)));
    }
  }

  input.on("data", onChunk);
  input.on("end", onEnd);
  input.on("error", onErr);

  let writeTail = Promise.resolve();

  function writeLine(line: string): Promise<void> {
    writeTail = writeTail.then(
      () =>
        new Promise<void>((res, rej) => {
          const payload = `${line}\n`;
          const ok = output.write(payload, (err) => {
            if (err) {
              rej(err);
              return;
            }
            if (ok) {
              res();
            } else {
              output.once("drain", res);
            }
          });
        }),
    );
    return writeTail;
  }

  async function request(method: string, params?: unknown): Promise<unknown> {
    if (closed || inputEnded) {
      throw new Error("MCP session is closed");
    }
    const id = nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params === undefined ? {} : params,
    });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void writeLine(body).catch((err) => {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  function notify(method: string, params?: unknown): void {
    if (closed) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params === undefined ? {} : params,
    });
    void writeLine(body);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    input.off("data", onChunk);
    input.off("end", onEnd);
    input.off("error", onErr);
    failAll(new Error("MCP session closed"));
    await new Promise<void>((resolve) => {
      if (output.writableEnded) {
        resolve();
        return;
      }
      output.end(() => resolve());
    });
  }

  return { request, notify, close };
}

export interface McpStdioConnectOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** When provided, the MCP server process is spawned and managed via procman. */
  readonly processManager?: ProcessManager;
}

export interface McpTcpConnectOptions {
  readonly host: string;
  readonly port: number;
}

/** Spawn a subprocess and return an MCP session on its stdio (JSON-RPC lines). */
export async function connectMcpStdioSession(opts: McpStdioConnectOptions): Promise<McpJsonRpcSession> {
  if (opts.processManager) {
    return connectMcpStdioSessionViaProcman(opts, opts.processManager);
  }
  return connectMcpStdioSessionDirect(opts);
}

/** Direct spawn fallback (original behavior). */
async function connectMcpStdioSessionDirect(opts: McpStdioConnectOptions): Promise<McpJsonRpcSession> {
  const proc = spawn(opts.command, opts.args ? [...opts.args] : [], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const out = proc.stdout;
  const inp = proc.stdin;
  if (!out || !inp) {
    throw new Error("MCP stdio spawn did not yield stdin/stdout pipes");
  }
  const session = createMcpJsonRpcSession(out, inp);
  const baseClose = session.close.bind(session);
  return {
    request: session.request,
    notify: session.notify,
    close: async () => {
      await baseClose().catch(() => {});
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          r();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}

/** Spawn via ProcessManager and wire the MCP session to the managed process's stdio. */
async function connectMcpStdioSessionViaProcman(
  opts: McpStdioConnectOptions,
  pm: ProcessManager,
): Promise<McpJsonRpcSession> {
  const scopeId = [opts.command, ...(opts.args ?? [])].join(" ");
  const specId = `mcp-stdio-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}-${Date.now()}`;

  const spec: ProcessSpec = {
    id: specId,
    owner: { kind: "mcp-server", scopeId },
    command: opts.command,
    args: opts.args ? [...opts.args] : undefined,
    cwd: opts.cwd,
    env: opts.env ? { ...opts.env } as Record<string, string> : undefined,
    restart: { mode: "on-failure", maxRetries: 5 },
    stdio: { capture: "pipe", stdin: true },
    shutdown: { signal: "SIGTERM", graceMs: 5000 },
  };

  const managed: ManagedProcess = await pm.start(spec);

  // The managed process exposes stdout/stdin via events and writeStdin.
  // We need Readable/Writable streams for createMcpJsonRpcSession.
  // Build a PassThrough for stdout that receives data from the managed process events,
  // and a writable shim that forwards to managed.writeStdin.
  const { PassThrough } = await import("node:stream");
  const stdoutStream = new PassThrough();
  managed.on("stdout", (chunk: Buffer) => {
    stdoutStream.write(chunk);
  });

  // Writable shim that delegates to managed.writeStdin
  const stdinStream = new PassThrough();
  stdinStream.on("data", (chunk: Buffer) => {
    try {
      managed.writeStdin(chunk);
    } catch {
      // process may have exited
    }
  });

  const session = createMcpJsonRpcSession(stdoutStream, stdinStream);
  const baseClose = session.close.bind(session);

  return {
    request: session.request,
    notify: session.notify,
    close: async () => {
      await baseClose().catch(() => {});
      stdoutStream.destroy();
      stdinStream.destroy();
      try {
        await pm.stop(specId);
      } catch {
        // already stopped or removed
      }
    },
  };
}

/** TCP client: same newline-delimited JSON-RPC as MCP stdio transports. */
export async function connectMcpTcpSession(opts: McpTcpConnectOptions): Promise<McpJsonRpcSession> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection({ host: opts.host, port: opts.port }, () => resolve(s));
    s.once("error", reject);
  });
  const session = createMcpJsonRpcSession(socket, socket);
  const baseClose = session.close.bind(session);
  return {
    request: session.request,
    notify: session.notify,
    close: async () => {
      await baseClose().catch(() => {});
      socket.destroy();
    },
  };
}

/**
 * Full connect handshake for stdio: spawn, initialize, ready for `tools/list` / `tools/call`.
 */
export async function openMcpStdioClient(opts: McpStdioConnectOptions): Promise<McpJsonRpcSession> {
  const s = await connectMcpStdioSession(opts);
  await mcpInitializeSession(s);
  return s;
}

/**
 * Full connect handshake for TCP.
 */
export async function openMcpTcpClient(opts: McpTcpConnectOptions): Promise<McpJsonRpcSession> {
  const s = await connectMcpTcpSession(opts);
  await mcpInitializeSession(s);
  return s;
}
