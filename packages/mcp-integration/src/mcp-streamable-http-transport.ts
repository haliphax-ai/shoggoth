import type { McpJsonRpcSession } from "./mcp-jsonrpc-transport";
import { mcpInitializeSession } from "./mcp-jsonrpc-transport";

/** One SSE event's parsed JSON payload and optional `id:` field (for `Last-Event-ID` resumption). */
export interface McpSseJsonEvent {
  readonly eventId?: string;
  readonly json: unknown;
}

/** Streamable HTTP session plus optional SSE resumption introspection. */
export type McpStreamableHttpSession = McpJsonRpcSession & {
  readonly getLastSseEventId: () => string | undefined;
  /**
   * Ask the server to cancel an in-flight request (same JSON-RPC `id` you used for `request()`).
   * Sends MCP **`notifications/cancelled`** with `params.requestId` per 2025-11-25 cancellation.
   */
  readonly cancelRequest: (rpcId: number) => void;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

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

/** Inbound JSON-RPC object from standing GET SSE, POST-response SSE, or other server push (notifications, orphan responses). */
export type McpStreamableHttpServerMessage = Readonly<Record<string, unknown>>;

export interface McpStreamableHttpConnectOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** MCP `initialize` body `protocolVersion` (defaults to `2025-11-25` for streamable HTTP). */
  readonly protocolVersion?: string;
  /** First `MCP-Protocol-Version` request header before negotiation (default `2025-11-25`). */
  readonly initialMcpProtocolVersionHeader?: string;
  /**
   * Called for inbound JSON-RPC **notifications** (no `id`), responses whose `id` is not in the local
   * pending map (server push), and after a matching **`notifications/cancelled`** is applied (promise
   * rejected). Malformed SSE payloads stay silent unless you parse streams yourself.
   */
  readonly onServerMessage?: (msg: McpStreamableHttpServerMessage) => void;
}

type Pending = {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  extra: Record<string, string>,
): Record<string, string> {
  return { ...(base ?? {}), ...extra };
}

const SSE_EVENT_BOUNDARY = /\r\n\r\n|\n\n/;

function parseSseEventBlock(raw: string): { eventId?: string; dataPayload: string | undefined } {
  const dataParts: string[] = [];
  let eventId: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      const v = line.slice(3).replace(/^\u0020/, "");
      if (v.length > 0 && !v.includes("\0")) {
        eventId = v;
      }
      continue;
    }
    if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).replace(/^\u0020/, ""));
    }
  }
  if (dataParts.length === 0) {
    return { eventId, dataPayload: undefined };
  }
  const payload = dataParts.join("\n");
  return { eventId, dataPayload: payload || undefined };
}

/**
 * Parses `text/event-stream` bodies: events separated by a blank line, `data:` joined per spec, optional `id:` per event.
 */
export async function* iterateSseDataJson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<McpSseJsonEvent> {
  if (!body) return;
  const decoder = new TextDecoderStream();
  const reader = body.pipeThrough(decoder).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (;;) {
      const m = SSE_EVENT_BOUNDARY.exec(buf);
      if (!m || m.index < 0) break;
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const { eventId, dataPayload } = parseSseEventBlock(raw);
      if (!dataPayload) continue;
      try {
        yield { eventId, json: JSON.parse(dataPayload) as unknown };
      } catch {
        /* ignore malformed event */
      }
    }
  }
  if (buf.trim()) {
    const { eventId, dataPayload } = parseSseEventBlock(buf);
    if (dataPayload) {
      try {
        yield { eventId, json: JSON.parse(dataPayload) as unknown };
      } catch {
        /* ignore */
      }
    }
  }
}

/** Coerce JSON-RPC `id` / cancellation `requestId` to a finite number for this client’s numeric pending map. */
function normalizeJsonRpcNumericId(idRaw: unknown): number | null {
  if (idRaw === undefined || idRaw === null) return null;
  const n = typeof idRaw === "number" ? idRaw : Number(idRaw);
  return Number.isFinite(n) ? n : null;
}

/**
 * MCP 2025-11-25 cancellation: `notifications/cancelled` with `params.requestId` (+ optional `reason`).
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
 */
function tryRejectPendingFromCancelledNotification(m: Record<string, unknown>, pending: Map<number, Pending>): boolean {
  if (m.method !== "notifications/cancelled") return false;
  const params = asRecord(m.params);
  if (!params) return false;
  const rid = normalizeJsonRpcNumericId(params.requestId);
  if (rid === null) return false;
  const p = pending.get(rid);
  if (!p) return false;
  pending.delete(rid);
  const reason = typeof params.reason === "string" && params.reason.length > 0 ? params.reason : undefined;
  p.reject(new Error(reason !== undefined ? `MCP request cancelled: ${reason}` : "MCP request cancelled"));
  return true;
}

/**
 * Dispatches one JSON-RPC value from SSE or HTTP JSON. If a single SSE `data:` line parses to a **JSON array**,
 * each element is processed in order (minimal batch interop; not all servers use batch).
 */
function dispatchIncomingMessage(
  msg: unknown,
  pending: Map<number, Pending>,
  onServerMessage?: (m: Record<string, unknown>) => void,
): void {
  if (Array.isArray(msg)) {
    for (const item of msg) {
      dispatchIncomingMessage(item, pending, onServerMessage);
    }
    return;
  }
  const m = asRecord(msg);
  if (!m) return;

  if (tryRejectPendingFromCancelledNotification(m, pending)) {
    onServerMessage?.(m);
    return;
  }

  const idRaw = m.id;
  if (idRaw === undefined || idRaw === null) {
    onServerMessage?.(m);
    return;
  }
  const id = normalizeJsonRpcNumericId(idRaw);
  if (id === null) {
    onServerMessage?.(m);
    return;
  }
  const p = pending.get(id);
  if (!p) {
    onServerMessage?.(m);
    return;
  }
  pending.delete(id);
  if (m.error !== undefined) {
    p.reject(jsonRpcErrorToError(m.error));
  } else {
    p.resolve(m.result);
  }
}

/**
 * MCP Streamable HTTP: POST JSON-RPC per message; responses may be `application/json`, `text/event-stream`
 * (SSE) on the POST body, or `202 Accepted` with the JSON-RPC reply on a standing `GET` SSE stream.
 * If `GET` returns 405/404, the client disables the standing stream and uses POST-only behavior.
 * Uses `fetch` and Web Streams only.
 */
export function connectMcpStreamableHttpSession(opts: McpStreamableHttpConnectOptions): McpStreamableHttpSession {
  const endpoint = normalizeBaseUrl(opts.url);
  const baseHeaders = opts.headers ?? {};
  const serverMessageHandler = opts.onServerMessage;
  let mcpSessionId: string | undefined;
  let mcpProtocolVersionHeader = opts.initialMcpProtocolVersionHeader ?? "2025-11-25";
  let closed = false;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  const abortGlobal = new AbortController();
  let lastSseEventId: string | undefined;
  /** When true, server rejected GET (e.g. POST-only mock); rely on POST responses only. */
  let standingGetDisabled = false;
  let standingGetStarted = false;
  let getFetchAbort = new AbortController();

  function restartGetFetch(): void {
    getFetchAbort.abort();
    getFetchAbort = new AbortController();
  }

  function buildRequestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      ...baseHeaders,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": mcpProtocolVersionHeader,
    };
    if (mcpSessionId !== undefined) {
      h["MCP-Session-Id"] = mcpSessionId;
    }
    return h;
  }

  function applySessionHeaders(res: Response): void {
    const sid = res.headers.get("mcp-session-id") ?? res.headers.get("MCP-Session-Id");
    if (sid) {
      const t = sid.trim();
      if (t !== mcpSessionId) {
        mcpSessionId = t;
        restartGetFetch();
      }
    }
  }

  /**
   * Streamable HTTP: long-lived GET + SSE delivers JSON-RPC (and notifications) in parallel with POST.
   * Disabled automatically if GET is not supported (405), so POST-only servers keep working.
   */
  async function runStandingGetLoop(): Promise<void> {
    while (!closed && !standingGetDisabled) {
      let resumeHeader: string | undefined = lastSseEventId;
      try {
        const getHeaders = mergeHeaders(buildRequestHeaders(), {
          ...(resumeHeader !== undefined && resumeHeader !== "" ? { "Last-Event-ID": resumeHeader } : {}),
        });
        const res = await fetch(endpoint, {
          method: "GET",
          headers: getHeaders,
          signal: AbortSignal.any([abortGlobal.signal, getFetchAbort.signal]),
        });
        applySessionHeaders(res);
        if (res.status === 405 || res.status === 404) {
          standingGetDisabled = true;
          return;
        }
        if (!res.ok) {
          await res.arrayBuffer().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("text/event-stream")) {
          await res.arrayBuffer().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        for await (const ev of iterateSseDataJson(res.body)) {
          if (closed) return;
          if (ev.eventId !== undefined && ev.eventId !== "") {
            lastSseEventId = ev.eventId;
          }
          dispatchIncomingMessage(ev.json, pending, serverMessageHandler);
        }
      } catch (e) {
        if (closed || abortGlobal.signal.aborted) return;
        const name = e instanceof Error ? e.name : "";
        if (name === "AbortError") {
          continue;
        }
        if (!standingGetDisabled) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }

  function ensureStandingGet(): void {
    if (closed || standingGetDisabled || standingGetStarted) return;
    standingGetStarted = true;
    void runStandingGetLoop();
  }

  /** Reads JSON-RPC from POST response SSE; `pending` must already include `rid`. Retries POST with Last-Event-ID when appropriate. */
  async function readSseRpcFromPostBodyWithRetry(
    initialRes: Response,
    rpcBody: Record<string, unknown>,
    rid: number,
  ): Promise<void> {
    let resumeLastEventId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sseRes =
        attempt === 0
          ? initialRes
          : await fetch(endpoint, {
              method: "POST",
              headers: mergeHeaders(buildRequestHeaders(), {
                "Content-Type": "application/json",
                ...(resumeLastEventId !== undefined ? { "Last-Event-ID": resumeLastEventId } : {}),
              }),
              body: JSON.stringify(rpcBody),
              signal: abortGlobal.signal,
            });
      if (attempt > 0) {
        applySessionHeaders(sseRes);
        if (!sseRes.ok) {
          const t = await sseRes.text().catch(() => "");
          throw new Error(`MCP HTTP request failed: ${sseRes.status} ${t}`);
        }
        const ct2 = sseRes.headers.get("content-type") ?? "";
        if (!ct2.includes("text/event-stream")) {
          throw new Error(`Unsupported MCP HTTP Content-Type after SSE resume: ${ct2 || "(empty)"}`);
        }
      }
      let lastEventIdThisAttempt: string | undefined;
      try {
        for await (const ev of iterateSseDataJson(sseRes.body)) {
          if (ev.eventId !== undefined && ev.eventId !== "") {
            lastEventIdThisAttempt = ev.eventId;
            lastSseEventId = ev.eventId;
          }
          dispatchIncomingMessage(ev.json, pending, serverMessageHandler);
          if (!pending.has(rid)) {
            return;
          }
        }
        if (attempt === 0 && lastEventIdThisAttempt !== undefined) {
          resumeLastEventId = lastEventIdThisAttempt;
          continue;
        }
        const p = pending.get(rid);
        if (p) {
          pending.delete(rid);
          p.reject(new Error("MCP SSE stream ended before JSON-RPC response"));
        }
        return;
      } catch (e) {
        const p = pending.get(rid);
        if (!p) {
          return;
        }
        if (attempt === 0 && lastEventIdThisAttempt !== undefined) {
          resumeLastEventId = lastEventIdThisAttempt;
          continue;
        }
        pending.delete(rid);
        p.reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    const p = pending.get(rid);
    if (p) {
      pending.delete(rid);
      p.reject(new Error("MCP SSE resumption exhausted"));
    }
  }

  async function postOnce(
    body: Record<string, unknown>,
    options: { readonly isNotification: boolean; readonly rpcId?: number },
  ): Promise<unknown> {
    if (closed) {
      throw new Error("MCP session is closed");
    }
    const jsonHeaders = mergeHeaders(buildRequestHeaders(), { "Content-Type": "application/json" });
    if (options.isNotification) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal: abortGlobal.signal,
      });
      applySessionHeaders(res);
      if (res.status === 202 || (res.ok && res.status === 200)) {
        await res.arrayBuffer().catch(() => undefined);
        ensureStandingGet();
        return undefined;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`MCP HTTP notification failed: ${res.status} ${t}`);
      }
      await res.arrayBuffer().catch(() => undefined);
      ensureStandingGet();
      return undefined;
    }
    const rid = options.rpcId;
    if (rid === undefined) {
      throw new Error("internal: request without rpc id");
    }
    return new Promise<unknown>((resolve, reject) => {
      pending.set(rid, { resolve, reject });
      void (async () => {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify(body),
            signal: abortGlobal.signal,
          });
          applySessionHeaders(res);
          ensureStandingGet();
          if (res.status === 202) {
            await res.arrayBuffer().catch(() => undefined);
            for (let i = 0; i < 20 && !standingGetDisabled; i++) {
              await new Promise((r) => setTimeout(r, 5));
            }
            if (standingGetDisabled && pending.has(rid)) {
              pending.delete(rid);
              reject(
                new Error(
                  "MCP HTTP 202 response requires GET SSE, but GET is not supported (server returned 405/404)",
                ),
              );
            }
            return;
          }
          if (!res.ok) {
            const t = await res.text().catch(() => "");
            if (pending.has(rid)) {
              pending.delete(rid);
              reject(new Error(`MCP HTTP request failed: ${res.status} ${t}`));
            }
            return;
          }
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) {
            const text = await res.text();
            let msg: unknown;
            try {
              msg = JSON.parse(text) as unknown;
            } catch (e) {
              if (pending.has(rid)) {
                pending.delete(rid);
                reject(new Error(`MCP HTTP response is not JSON: ${String(e)}`));
              }
              return;
            }
            dispatchIncomingMessage(msg, pending, serverMessageHandler);
            if (pending.has(rid)) {
              pending.delete(rid);
              reject(new Error("MCP HTTP JSON response missing matching JSON-RPC id"));
            }
            return;
          }
          if (ct.includes("text/event-stream")) {
            await readSseRpcFromPostBodyWithRetry(res, body, rid);
            return;
          }
          if (pending.has(rid)) {
            pending.delete(rid);
            reject(new Error(`Unsupported MCP HTTP Content-Type: ${ct || "(empty)"}`));
          }
        } catch (e) {
          if (pending.has(rid)) {
            pending.delete(rid);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      })();
    });
  }

  async function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
      params: params === undefined ? {} : params,
    };
    const result = await postOnce(body, { isNotification: false, rpcId: id });
    const initResult = asRecord(result);
    const pv = initResult?.protocolVersion;
    if (method === "initialize" && typeof pv === "string" && pv.length > 0) {
      mcpProtocolVersionHeader = pv;
    }
    return result;
  }

  function notify(method: string, params?: unknown): Promise<void> {
    if (closed) return Promise.resolve();
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      params: params === undefined ? {} : params,
    };
    return postOnce(body, { isNotification: true }).then(() => {});
  }

  /** Client-initiated cancel: MCP `notifications/cancelled` + `params.requestId`. */
  function cancelRequest(rpcId: number): void {
    if (closed) return;
    void notify("notifications/cancelled", { requestId: rpcId });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    abortGlobal.abort();
    const snapshot = [...pending.values()];
    pending.clear();
    for (const p of snapshot) {
      p.reject(new Error("MCP session closed"));
    }
    if (mcpSessionId !== undefined) {
      try {
        await fetch(endpoint, {
          method: "DELETE",
          headers: buildRequestHeaders(),
        });
      } catch {
        /* ignore */
      }
    }
  }

  return {
    request,
    notify,
    cancelRequest,
    close,
    getLastSseEventId: () => lastSseEventId,
  };
}

export async function openMcpStreamableHttpClient(opts: McpStreamableHttpConnectOptions): Promise<McpStreamableHttpSession> {
  const session = connectMcpStreamableHttpSession(opts);
  await mcpInitializeSession(session, {
    protocolVersion: opts.protocolVersion ?? "2025-11-25",
  });
  return session;
}
