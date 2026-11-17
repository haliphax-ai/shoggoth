#!/usr/bin/env tsx
/**
 * Standalone managed service entrypoint for the demo service.
 *
 * Run with: npx tsx packages/service-demo/src/server.ts [port]
 *
 * Exposes:
 *   GET  /              — HTML page showing current message
 *   GET  /health        — Lightweight health check (returns "ok")
 *   GET  /manifest      — Service manifest for Shoggoth discovery
 *   POST /_shoggoth/identity — Identity provisioning endpoint
 *   POST /api/set_message  — Set the displayed message (auth required)
 *   GET  /api/get_message  — Get the current message (auth required)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createIdentityHandler, TokenValidator } from "@shoggoth/service-auth";
import { getLogger } from "@shoggoth/shared";
import { DEFAULT_MESSAGE, demoManifest, escapeHtml } from "./shared.js";

const log = getLogger("demo-service");

const PORT = Number(process.env.DEMO_SERVICE_PORT) || Number(process.argv[2]) || 3200;
const HOST = process.env.DEMO_SERVICE_HOST || "127.0.0.1";

const KEY_PATH =
  process.env.DEMO_SERVICE_KEY_PATH || "/var/lib/shoggoth/daemon/demo-service-identity.key";
const PROVISION_SECRET =
  process.env.DEMO_PROVISION_SECRET || process.env.SHOGGOTH_PROVISION_SECRET || "";

/** In-memory message displayed by the demo service. */
let message = DEFAULT_MESSAGE;

/** Stored identity for token validation. */
let storedIdentity: string | null = null;

// Load identity from file on startup if it exists
try {
  if (existsSync(KEY_PATH)) {
    storedIdentity = readFileSync(KEY_PATH, "utf-8").trim();
  }
} catch {
  // Ignore read errors on startup
}

/**
 * Persist the current identity to disk without blocking the event loop.
 *
 * The service-auth `onReceive` callback is invoked synchronously and its
 * return value is never awaited, so provisioning treats this as
 * fire-and-forget and logs a warning when the write fails. Other call
 * sites can await the returned promise.
 */
async function writeIdentityFile(identity: string): Promise<void> {
  await writeFile(KEY_PATH, identity, "utf-8");
  log.info(`Identity written to ${KEY_PATH}`);
}

/** Identity handler using service-auth. */
const identityHandler = createIdentityHandler({
  provisionSecret: PROVISION_SECRET || undefined,
  onReceive(identity: string) {
    storedIdentity = identity;
    log.info(`Identity received and stored (${identity.slice(0, 20)}...)`);
    writeIdentityFile(identity).catch((err: unknown) => {
      log.warn(`Failed to write identity to ${KEY_PATH}`, { err: String(err) });
    });
  },
});

/** Service manifest returned at GET /manifest. */
const manifest = demoManifest;

/** Maximum accepted request body size (1 MiB); larger requests are rejected with 413. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Error thrown by readBody when the request body exceeds MAX_BODY_BYTES. */
class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // keep draining so the 413 response can be delivered
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0; // drop the partial buffer
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Parsed request context handed to route handlers. */
interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** URL pathname (query string stripped). */
  pathname: string;
  /** Uppercased HTTP method; defaults to GET like the previous control flow. */
  method: string;
  /** Raw Authorization header value, if present. */
  authorization: string | undefined;
}

/**
 * Guard for /api/* handlers: validates the Bearer token against the stored
 * identity. Returns true (and may have written a 401 response) when the
 * handler must not proceed.
 */
async function requireBearerToken(ctx: RequestContext): Promise<boolean> {
  const header = ctx.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    json(ctx.res, 401, { error: "missing or invalid authorization header" });
    return false;
  }

  if (!storedIdentity) {
    json(ctx.res, 401, { error: "service identity not provisioned" });
    return false;
  }

  const payload = await TokenValidator.validate(header.slice(7), storedIdentity);
  if (!payload) {
    json(ctx.res, 401, { error: "invalid or expired token" });
    return false;
  }

  return true;
}

/** Body read outcome; `ok: false` means a 400/413 response was already written. */
type BodyResult = { ok: true; value: unknown } | { ok: false };

/**
 * Read the request body as JSON. On failure a 400/413 response is written
 * and `{ ok: false }` is returned; the wording and status codes match the
 * previous control flow exactly. A body whose JSON value is literally
 * `null` parses successfully and is reported via `value`.
 */
async function readBodyAsJson(req: IncomingMessage, res: ServerResponse): Promise<BodyResult> {
  const raw = await readBody(req).catch((err: unknown) => {
    if (err instanceof PayloadTooLargeError) {
      json(res, 413, { error: "request body too large" });
      return null;
    }
    throw err;
  });
  if (raw === null) return { ok: false };

  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    json(res, 400, { error: "invalid JSON body" });
    return { ok: false };
  }
}

/**
 * Read a top-level field from a parsed JSON body. Non-object bodies (arrays,
 * strings, numbers, booleans, null) have no fields, so this yields
 * `undefined` for them instead of throwing.
 */
function bodyField(parsed: unknown, key: string): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as Record<string, unknown>)[key];
}

/**
 * Attempt to rotate the stored identity using a Bearer token.
 *
 * A rotation request carries a `Bearer` token that must validate against the
 * currently stored identity. When the credentials do not qualify (no Bearer
 * token, nothing stored yet, or an invalid token), the request is reported as
 * unhandled so the caller can fall through to provision-secret handling.
 *
 * Returns true when the request was fully handled (a response was written).
 */
async function tryRotateIdentity(ctx: RequestContext, parsed: unknown): Promise<boolean> {
  const authHeader = ctx.authorization;
  if (!authHeader?.startsWith("Bearer ") || !storedIdentity) {
    return false;
  }

  const payload = await TokenValidator.validate(authHeader.slice(7), storedIdentity);
  if (!payload) {
    // Invalid token — fall through to provision secret check
    return false;
  }

  // Valid token — allow rotation. Same truthiness gate as before: any
  // missing/empty/non-string identity is rejected here.
  const identity = bodyField(parsed, "identity");
  if (typeof identity !== "string" || identity.length === 0) {
    json(ctx.res, 400, { error: "Missing identity in request body" });
    return true;
  }

  storedIdentity = identity;
  log.info(`Identity rotated (${identity.slice(0, 20)}...)`);
  try {
    await writeIdentityFile(identity);
  } catch (err) {
    log.warn(`Failed to write rotated identity to ${KEY_PATH}`, { err: String(err) });
  }
  json(ctx.res, 200, { ok: true });
  return true;
}

/**
 * Provision an identity using the shared provision secret. This is the
 * bootstrap path for requests that were not rotated via Bearer token; any
 * identity-handler rejection surfaces as 403.
 */
function provisionViaSecret(ctx: RequestContext, parsed: unknown): void {
  try {
    const result = identityHandler({
      headers: {
        "x-provision-secret": ctx.req.headers["x-provision-secret"] as string | undefined,
        authorization: ctx.authorization,
      },
      body: parsed as { identity: string },
    });
    json(ctx.res, 200, result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Forbidden";
    json(ctx.res, 403, { error: msg });
  }
}

/** Route handler; returns normally after the response has been written. */
type RouteHandler = (ctx: RequestContext) => Promise<void>;

/** Route matcher; true when this route should handle the request. */
type RouteMatcher = (pathname: string, method: string) => boolean;

/** A single route: a matcher plus its handler. */
interface Route {
  match: RouteMatcher;
  handle: RouteHandler;
}

function exact(method: string, pathname: string): RouteMatcher {
  return (p, m) => p === pathname && m === method;
}

/** Routes are evaluated top to bottom; the first matcher wins. */
const routes: Route[] = [
  {
    // GET / — HTML page
    match: exact("GET", "/"),
    handle: async ({ res }) => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo Service</title></head>
<body>
<h1>Demo Service</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
  },
  {
    // GET /health — lightweight health check
    match: exact("GET", "/health"),
    handle: async ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    },
  },
  {
    // GET /manifest — service manifest
    match: exact("GET", "/manifest"),
    handle: async ({ res }) => {
      json(res, 200, manifest);
    },
  },
  {
    // POST /_shoggoth/identity — identity provisioning
    match: exact("POST", "/_shoggoth/identity"),
    handle: async (ctx) => {
      const body = await readBodyAsJson(ctx.req, ctx.res);
      if (!body.ok) return;
      if (await tryRotateIdentity(ctx, body.value)) return;
      provisionViaSecret(ctx, body.value);
    },
  },
  {
    // POST /api/set_message — set the message (Bearer token required)
    match: exact("POST", "/api/set_message"),
    handle: async (ctx) => {
      if (!(await requireBearerToken(ctx))) return;
      const body = await readBodyAsJson(ctx.req, ctx.res);
      if (!body.ok) return;
      const requested = bodyField(body.value, "message");
      if (typeof requested !== "string") {
        json(ctx.res, 400, { error: "message must be a string" });
        return;
      }
      message = requested;
      json(ctx.res, 200, { ok: true, message });
    },
  },
  {
    // GET /api/get_message — get the message (Bearer token required)
    match: exact("GET", "/api/get_message"),
    handle: async (ctx) => {
      if (!(await requireBearerToken(ctx))) return;
      json(ctx.res, 200, { message });
    },
  },
  {
    // Any other /api/* path: reject with the Bearer auth errors before 404
    match: (pathname) => pathname.startsWith("/api/"),
    handle: async (ctx) => {
      if (!(await requireBearerToken(ctx))) return;
      json(ctx.res, 404, { error: "not found" });
    },
  },
];

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() ?? "GET";
  const authorizationHeader = req.headers["authorization"];
  const ctx: RequestContext = {
    req,
    res,
    pathname,
    method,
    authorization: authorizationHeader,
  };

  for (const route of routes) {
    if (route.match(pathname, method)) {
      await route.handle(ctx);
      return;
    }
  }

  // 404
  json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    log.error("Request error", { err: String(err) });
    if (!res.headersSent) {
      if (err instanceof PayloadTooLargeError) {
        json(res, 413, { error: "request body too large" });
      } else {
        json(res, 500, { error: "internal server error" });
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  log.info(`Demo service listening on http://${HOST}:${PORT}`, {
    manifest: `http://${HOST}:${PORT}/manifest`,
    tools: "demo.set_message, demo.get_message",
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
