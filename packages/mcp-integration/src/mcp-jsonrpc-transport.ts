import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { ProcessManager, ManagedProcess, ProcessSpec } from "@shoggoth/procman";
import type { JsonSchemaLike } from "./json-schema";
import type { McpSourceCatalog } from "./aggregate";
import type { McpToolDescriptor } from "./mcp-tool";
import { MCP_PROTOCOL_VERSION_STDIO } from "./mcp-protocol-versions";
import { asRecord, jsonRpcErrorToError } from "./json-rpc-helpers";

/** MCP JSON-RPC session over newline-delimited JSON (stdio or TCP with same framing). */
export interface McpJsonRpcSession {
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  /** Always a Promise so `notifications/initialized` can await 202 on every transport. */
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Server-initiated JSON-RPC notification (message with a `method` and no `id`). */
export interface McpServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** Tap invoked for each server-initiated JSON-RPC notification received on a session. */
export type McpServerNotificationHandler = (msg: McpServerNotification) => void;

export interface McpToolListEntry {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
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
    protocolVersion: options?.protocolVersion ?? MCP_PROTOCOL_VERSION_STDIO,
    capabilities: {},
    clientInfo: { name: "shoggoth", version: "0.1.0" },
  });
  await session.notify("notifications/initialized", {});
}

/**
 * Collects all pages from `tools/list`.
 *
 * Tool entries that do not match the expected shape (an object with a string
 * `name`) are skipped; pass `options.onSkippedToolEntry` to be notified of each
 * skipped entry so server-side bugs are not silently masked.
 */
export async function mcpFetchToolsList(
  session: McpJsonRpcSession,
  options?: {
    /** Called once per `tools/list` entry that does not match the expected shape. */
    readonly onSkippedToolEntry?: (entry: unknown) => void;
  },
): Promise<McpToolListEntry[]> {
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
        } else {
          options?.onSkippedToolEntry?.(t);
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
export function mcpToolsToSourceCatalog(
  sourceId: string,
  tools: readonly McpToolListEntry[],
): McpSourceCatalog {
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

/** Default request timeout for pending JSON-RPC requests (60 seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type Pending = {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  /** Timestamp (ms) when this entry was added to the pending map. */
  readonly createdAt: number;
  /** The JSON-RPC method name, used in stale-entry error messages. */
  readonly method: string;
};

/**
 * Low-level: newline-delimited JSON-RPC 2.0 over separate readable/writable streams.
 * Supports concurrent requests; server notifications (messages with a `method` and
 * no `id`) are delivered to the optional `onServerNotification` tap.
 */
export function createMcpJsonRpcSession(
  input: Readable,
  output: Writable,
  options?: {
    readonly onReaderError?: (err: unknown) => void;
    readonly onProtocolError?: (err: unknown) => void;
    /**
     * Invoked for each server-initiated JSON-RPC notification (message with a
     * `method` and no `id`) received on this session. Tap errors are swallowed so
     * the read loop never breaks. Responses to this client's requests are not
     * delivered here; only id-less inbound messages are.
     */
    readonly onServerNotification?: McpServerNotificationHandler;
    /**
     * Timeout in milliseconds for pending JSON-RPC requests. If a response is not
     * received within this time, the pending promise is rejected with a timeout error.
     * Set to `null` to disable timeouts. Defaults to 60 seconds.
     */
    readonly requestTimeout?: number | null;
  },
): McpJsonRpcSession {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const timers = new Map<number, NodeJS.Timeout>();
  let buffer = "";
  let closed = false;
  let inputEnded = false;

  // Periodic stale-entry cleanup (belt-and-suspenders with per-request timers).
  // Runs every 30 s and rejects any pending entry older than requestTimeout.
  const STALE_CLEANUP_INTERVAL_MS = 30_000;
  const staleCleanupTimer = setInterval(() => {
    if (closed) return;
    const timeoutMs = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (timeoutMs === null || timeoutMs <= 0) return;
    const now = Date.now();
    for (const [id, p] of pending) {
      if (now - p.createdAt > timeoutMs) {
        pending.delete(id);
        const t = timers.get(id);
        if (t !== undefined) {
          clearTimeout(t);
          timers.delete(id);
        }
        p.reject(
          new Error(
            `MCP JSON-RPC stale pending entry cleaned up after ${Math.round((now - p.createdAt) / 1000)}s (method=${p.method}, id=${id})`,
          ),
        );
      }
    }
  }, STALE_CLEANUP_INTERVAL_MS);

  function failAll(err: Error): void {
    for (const [id, p] of pending) {
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(id);
      }
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
        // JSON-RPC notification (server-initiated, no id). Deliver to the tap when
        // it carries a method; id-less responses and malformed shapes stay ignored.
        const method = m.method;
        if (typeof method === "string") {
          try {
            options?.onServerNotification?.({ method, params: m.params });
          } catch {
            // A throwing tap must never break the message read loop.
          }
        }
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
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(id);
      }
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
              // Guard against silent hang: if the stream emits error or closes
              // before the drain event, the promise must still settle.
              const cleanup = () => {
                output.removeListener("drain", onDrain);
                output.removeListener("error", onError);
                output.removeListener("close", onClose);
              };
              const onDrain = () => {
                cleanup();
                res();
              };
              const onError = (streamErr: Error) => {
                cleanup();
                rej(streamErr);
              };
              const onClose = () => {
                cleanup();
                rej(new Error("Stream closed before drain"));
              };
              output.once("drain", onDrain);
              output.once("error", onError);
              output.once("close", onClose);
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
      pending.set(id, { resolve, reject, createdAt: Date.now(), method });
      // Start a timeout timer if requestTimeout is configured
      const timeoutMs = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      if (timeoutMs !== null && timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            timers.delete(id);
            reject(
              new Error(
                `MCP JSON-RPC request timed out after ${timeoutMs}ms (id=${id}, method=${method})`,
              ),
            );
          }
        }, timeoutMs);
        timers.set(id, timer);
      }
      void writeLine(body).catch((err) => {
        if (pending.delete(id)) {
          const t = timers.get(id);
          if (t !== undefined) {
            clearTimeout(t);
            timers.delete(id);
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    if (closed) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: params === undefined ? {} : params,
    });
    await writeLine(body);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(staleCleanupTimer);
    input.off("data", onChunk);
    input.off("end", onEnd);
    input.off("error", onErr);
    failAll(new Error("MCP session closed"));
    await new Promise<void>((resolve) => {
      if (output.writableEnded || output.destroyed) {
        resolve();
        return;
      }
      // Bound the flush wait: against a dead peer the end callback may never
      // fire, and close() must not stall the caller.
      const t = setTimeout(resolve, 2_000);
      output.end(() => {
        clearTimeout(t);
        resolve();
      });
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
  /** When set, the MCP server process is spawned with this POSIX UID (agent identity). */
  readonly uid?: number;
  /** When set, the MCP server process is spawned with this POSIX GID (agent identity). */
  readonly gid?: number;
  /** Optional tap for server-initiated JSON-RPC notifications received on this session. */
  readonly onServerNotification?: McpServerNotificationHandler;
}

export interface McpTcpConnectOptions {
  readonly host: string;
  readonly port: number;
  /**
   * Optional deadline, in milliseconds, for the TCP handshake to complete.
   * When set, the connection attempt fails with `ETIMEDOUT` if the remote
   * host does not accept the connection in time. Omitted (or `0`) means wait
   * indefinitely, matching Node's default behavior.
   */
  readonly connectTimeout?: number;
  /** Optional tap for server-initiated JSON-RPC notifications received on this session. */
  readonly onServerNotification?: McpServerNotificationHandler;
}

/** Spawn a subprocess and return an MCP session on its stdio (JSON-RPC lines). */
export async function connectMcpStdioSession(
  opts: McpStdioConnectOptions,
): Promise<McpJsonRpcSession> {
  if (opts.processManager) {
    return connectMcpStdioSessionViaProcman(opts, opts.processManager);
  }
  return connectMcpStdioSessionDirect(opts);
}

/** Direct spawn fallback (original behavior). */
async function connectMcpStdioSessionDirect(
  opts: McpStdioConnectOptions,
): Promise<McpJsonRpcSession> {
  const hasIdentity = opts.uid !== undefined || opts.gid !== undefined;
  const proc = spawn(opts.command, opts.args ? [...opts.args] : [], {
    cwd: opts.cwd,
    uid: opts.uid,
    gid: opts.gid,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: ["pipe", "pipe", "ignore"],
    ...(hasIdentity ? { detached: true } : {}),
  });
  // Sink stream errors synchronously — on a failed spawn Node may destroy the
  // pipes with an error before anything else attaches a listener, and an
  // unhandled 'error' event on any stream is an uncaught exception. Write
  // failures against a dead/dying server (EPIPE, ERR_STREAM_DESTROYED) also
  // surface here; pending requests are already failed through the write
  // callback and the session's stdout handlers.
  proc.stdout?.on("error", () => {});
  proc.stdin?.on("error", () => {});
  // Attach failure handling synchronously — before any await — so EVERY spawn
  // failure mode (ENOENT, EACCES/EPERM, EMFILE/ENFILE, ENOEXEC/failed exec,
  // invalid uid/gid, resource exhaustion, ...) rejects the connect below
  // instead of surfacing as an unhandled 'error' event that takes the whole
  // daemon down. Node only emits 'spawn' when the child actually started;
  // 'error' without 'spawn' means the process never existed.
  let spawnedOk = false;
  const spawned = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => {
      spawnedOk = true;
      resolve();
    });
    proc.on("error", (err) => {
      if (!spawnedOk) {
        spawnedOk = true;
        reject(err);
      }
      // After a successful spawn, a late 'error' (e.g. a failed kill) must
      // never become unhandled; session death is detected via stdio EOF below.
    });
  });
  try {
    await spawned;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP stdio spawn failed for "${opts.command}": ${reason}`, { cause: err });
  }
  const out = proc.stdout;
  const inp = proc.stdin;
  if (!out || !inp) {
    throw new Error("MCP stdio spawn did not yield stdin/stdout pipes");
  }
  const session = createMcpJsonRpcSession(out, inp, {
    onServerNotification: opts.onServerNotification,
  });
  const baseClose = session.close.bind(session);
  return {
    request: session.request,
    notify: session.notify,
    close: async () => {
      await baseClose().catch(() => {});
      if (proc.exitCode !== null || proc.signalCode !== null) {
        // Already dead (crash between spawn and initialize, server exit, ...)
        // — 'exit' has fired and will not fire again; do not wait the grace.
        return;
      }
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
    env: opts.env ? ({ ...opts.env } as Record<string, string>) : undefined,
    uid: opts.uid,
    gid: opts.gid,
    restart: { mode: "on-failure", maxRetries: 5 },
    stdio: { capture: "pipe", stdin: true },
    shutdown: { signal: "SIGTERM", graceMs: 5000 },
  };

  const managed: ManagedProcess = await pm.start(spec);

  // pm.start() never rejects on a failed spawn — the failure is recorded in
  // the process state instead — so check it here: wiring stdio to a process
  // that never started would hang the initialize handshake until its timeout
  // instead of failing the connect promptly.
  if (managed.state !== "running") {
    const failedState = managed.state;
    // Deregister and cancel any pending restart attempts for this spec.
    await pm.stop(specId).catch(() => {});
    throw new Error(
      `MCP stdio process failed to start via procman (state=${failedState}, command=${opts.command})`,
    );
  }

  // The managed process exposes stdout/stdin via events and writeStdin.
  // We need Readable/Writable streams for createMcpJsonRpcSession.
  // Build a PassThrough for stdout that receives data from the managed process events,
  // and a writable shim that forwards to managed.writeStdin.
  const { PassThrough } = await import("node:stream");
  const stdoutStream = new PassThrough();
  managed.on("stdout", (chunk: Buffer) => {
    stdoutStream.write(chunk);
  });
  // When the managed process dies (crash, signal, failed restart), end the
  // stdout stream so pending requests (initialize) fail fast with EOF instead
  // of hanging until their request timeout.
  managed.on("exit", () => {
    if (!stdoutStream.destroyed && !stdoutStream.writableEnded) {
      stdoutStream.end();
    }
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

  const session = createMcpJsonRpcSession(stdoutStream, stdinStream, {
    onServerNotification: opts.onServerNotification,
  });
  const baseClose = session.close.bind(session);

  return {
    request: session.request,
    notify: session.notify,
    close: async () => {
      await baseClose().catch(() => {});
      stdoutStream.destroy();
      stdinStream.destroy();
      await pm.stop(specId);
    },
  };
}

/** TCP client: same newline-delimited JSON-RPC as MCP stdio transports. */
export async function connectMcpTcpSession(opts: McpTcpConnectOptions): Promise<McpJsonRpcSession> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection({ host: opts.host, port: opts.port }, () => {
      // The deadline only guards the connect phase: clear it once the
      // handshake completes so an established session is never torn down
      // for idling.
      if (opts.connectTimeout !== undefined) s.setTimeout(0);
      resolve(s);
    });
    s.once("error", reject);
    const connectTimeout = opts.connectTimeout;
    if (connectTimeout !== undefined) {
      s.setTimeout(connectTimeout, () => {
        const err: NodeJS.ErrnoException = new Error(
          `MCP TCP connect timed out after ${connectTimeout}ms (${opts.host}:${opts.port})`,
        );
        err.code = "ETIMEDOUT";
        s.destroy(err);
      });
    }
  });
  const session = createMcpJsonRpcSession(socket, socket, {
    onServerNotification: opts.onServerNotification,
  });
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
  try {
    await mcpInitializeSession(s);
  } catch (err) {
    // Never leak the spawned server when the handshake fails (process died
    // between spawn and initialize, protocol mismatch, timeout, ...).
    await s.close().catch(() => {});
    throw err;
  }
  return s;
}

/**
 * Full connect handshake for TCP.
 */
export async function openMcpTcpClient(opts: McpTcpConnectOptions): Promise<McpJsonRpcSession> {
  const s = await connectMcpTcpSession(opts);
  try {
    await mcpInitializeSession(s);
  } catch (err) {
    // Never leak the socket when the handshake fails.
    await s.close().catch(() => {});
    throw err;
  }
  return s;
}
