#!/usr/bin/env tsx
/**
 * Standalone managed service entrypoint for the demo service.
 *
 * Run with: npx tsx packages/service-demo/src/server.ts [port].
 * Endpoints and their auth requirements are documented in docs/services.md
 * ("Writing a Service — Required Endpoints").
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createIdentityHandler,
  TokenValidator,
  type ServiceTokenPayload,
} from "@shoggoth/service-auth";
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

/**
 * Load the persisted identity from disk, or null when the file is missing
 * or unreadable.
 */
function loadStoredIdentity(): string | null {
  try {
    return readFileSync(KEY_PATH, "utf-8").trim();
  } catch {
    return null;
  }
}

/** Stored identity for token validation. */
let storedIdentity: string | null = loadStoredIdentity();

/**
 * Tail of an in-module promise-chain mutex guarding `storedIdentity`.
 * Async handlers interleave at every `await`; without serializing the
 * read-validate-write on the identity, two concurrent rotations (or a
 * rotation racing a provision) could store an identity nobody validated.
 * See docs/services.md ("Identity Mutation Serialization").
 */
let identityLockTail: Promise<void> = Promise.resolve();

/**
 * Run `fn` once all previously queued identity critical sections have
 * finished. `fn` may be sync or async; its result and rejections pass
 * through to the caller unchanged. The lock tail is always restored to a
 * resolved promise, so a failing section never breaks the chain for later
 * callers.
 */
function withIdentityLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = identityLockTail.then(fn);
  identityLockTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  /** Parsed JSON body; set by the dispatcher when the route opts into body parsing. */
  body?: unknown;
}

/**
 * Guard for routes that declare `auth`: validates the Bearer token against
 * the stored identity. Returns true (and may have written a 401 response)
 * when the request must not proceed. Runs under the identity lock so a
 * token can never be validated against an identity mid-rotation.
 */
async function requireBearerToken(ctx: RequestContext): Promise<boolean> {
  return withIdentityLock(() => validateBearerToken(ctx));
}

/** Body of the auth guard, run under the identity lock. */
async function validateBearerToken(ctx: RequestContext): Promise<boolean> {
  const header = ctx.authorization;
  if (!header?.startsWith("Bearer ")) {
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
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err: unknown) {
    if (err instanceof PayloadTooLargeError) {
      json(res, 413, { error: "request body too large" });
      return { ok: false };
    }
    throw err;
  }

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
  if (!(parsed instanceof Object) || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as Record<string, unknown>)[key];
}

/**
 * Validate the Bearer token of a rotation request against the currently
 * stored identity. Returns null when the request does not carry usable
 * rotation credentials (no Bearer token, nothing stored yet, or an invalid
 * token); the caller then falls through to provision-secret handling.
 */
async function rotationPayload(ctx: RequestContext): Promise<ServiceTokenPayload | null> {
  const authHeader = ctx.authorization;
  if (!authHeader?.startsWith("Bearer ") || !storedIdentity) {
    return null;
  }
  return TokenValidator.validate(authHeader.slice(7), storedIdentity);
}

/**
 * Attempt to rotate the stored identity using a Bearer token.
 *
 * A valid Bearer token authorizes the rotation: a missing or non-string
 * identity in the body is rejected with 400, otherwise the new identity is
 * stored and persisted. Returns true when the request was fully handled (a
 * response was written), false when the request carried no usable rotation
 * credentials and the response is left unwritten for provision-secret
 * handling.
 */
async function tryRotateIdentity(ctx: RequestContext, parsed: unknown): Promise<boolean> {
  const payload = await rotationPayload(ctx);
  if (!payload) {
    return false;
  }

  // Same truthiness gate as before: any missing/empty/non-string identity is
  // rejected here.
  const identity = bodyField(parsed, "identity");
  if (typeof identity !== "string" || identity.length === 0) {
    json(ctx.res, 400, { error: "Missing identity in request body" });
    return true;
  }

  storedIdentity = identity;
  log.info(`Identity rotated (${identity.slice(0, 20)}...)`);
  await writeRotatedIdentity(identity);
  json(ctx.res, 200, { ok: true });
  return true;
}

/** Persist a rotated identity, logging (but not failing) when the write fails. */
async function writeRotatedIdentity(identity: string): Promise<void> {
  try {
    await writeIdentityFile(identity);
  } catch (err) {
    log.warn(`Failed to write rotated identity to ${KEY_PATH}`, { err: String(err) });
  }
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

/** A single route: a matcher, its handler, and optional dispatcher gates. */
interface Route {
  match: RouteMatcher;
  handle: RouteHandler;
  /** Require a valid Bearer token before the handler runs. */
  auth?: boolean;
  /** Read and JSON-parse the request body into ctx.body before the handler runs. */
  parseBody?: boolean;
}

function exact(method: string, pathname: string): RouteMatcher {
  return (p, m) => p === pathname && m === method;
}

async function handleHome({ res }: RequestContext): Promise<void> {
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
}

async function handleHealth({ res }: RequestContext): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}

async function handleManifest({ res }: RequestContext): Promise<void> {
  json(res, 200, manifest);
}

async function handleIdentity(ctx: RequestContext): Promise<void> {
  // Both writers of `storedIdentity` (rotation and provisioning) are
  // reachable only through this handler, so locking here serializes every
  // read-validate-write on the identity.
  await withIdentityLock(async () => {
    if (await tryRotateIdentity(ctx, ctx.body)) return;
    provisionViaSecret(ctx, ctx.body);
  });
}

async function handleSetMessage(ctx: RequestContext): Promise<void> {
  const requested = bodyField(ctx.body, "message");
  if (typeof requested !== "string") {
    json(ctx.res, 400, { error: "message must be a string" });
    return;
  }
  message = requested;
  json(ctx.res, 200, { ok: true, message });
}

async function handleGetMessage({ res }: RequestContext): Promise<void> {
  json(res, 200, { message });
}

async function handleApiNotFound({ res }: RequestContext): Promise<void> {
  json(res, 404, { error: "not found" });
}

/** Routes are evaluated top to bottom; the first matcher wins. */
const routes: Route[] = [
  {
    // GET / — HTML page
    match: exact("GET", "/"),
    handle: handleHome,
  },
  {
    // GET /health — lightweight health check
    match: exact("GET", "/health"),
    handle: handleHealth,
  },
  {
    // GET /manifest — service manifest
    match: exact("GET", "/manifest"),
    handle: handleManifest,
  },
  {
    // POST /_shoggoth/identity — identity provisioning
    match: exact("POST", "/_shoggoth/identity"),
    parseBody: true,
    handle: handleIdentity,
  },
  {
    // POST /api/set_message — set the message (Bearer token required)
    match: exact("POST", "/api/set_message"),
    auth: true,
    parseBody: true,
    handle: handleSetMessage,
  },
  {
    // GET /api/get_message — get the message (Bearer token required)
    match: exact("GET", "/api/get_message"),
    auth: true,
    handle: handleGetMessage,
  },
  {
    // Any other /api/* path: reject with the Bearer auth errors before 404
    match: (pathname) => pathname.startsWith("/api/"),
    auth: true,
    handle: handleApiNotFound,
  },
];

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const ctx: RequestContext = {
    req,
    res,
    pathname,
    method,
    authorization: req.headers["authorization"],
  };

  const route = routes.find((candidate) => candidate.match(pathname, method));
  if (!route) {
    // 404
    json(res, 404, { error: "not found" });
    return;
  }
  if (route.auth && !(await requireBearerToken(ctx))) return;
  if (route.parseBody) {
    const parsed = await readBodyAsJson(req, res);
    if (!parsed.ok) return;
    ctx.body = parsed.value;
  }
  await route.handle(ctx);
}

/** Log a failed request and answer 500 unless a response was already sent. */
function respondToServerError(res: ServerResponse, err: unknown): void {
  log.error("Request error", { err: String(err) });
  if (!res.headersSent) {
    json(res, 500, { error: "internal server error" });
  }
}

const server = createServer((req, res) => {
  handler(req, res).catch((err: unknown) => respondToServerError(res, err));
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
