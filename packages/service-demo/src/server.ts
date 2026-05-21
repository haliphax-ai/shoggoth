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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createIdentityHandler, TokenValidator } from "@shoggoth/service-auth";

const PORT = Number(process.env.DEMO_SERVICE_PORT) || Number(process.argv[2]) || 3200;
const HOST = process.env.DEMO_SERVICE_HOST || "127.0.0.1";

const KEY_PATH = process.env.DEMO_SERVICE_KEY_PATH || "./demo-service-identity.key";
const PROVISION_SECRET =
  process.env.DEMO_PROVISION_SECRET || process.env.SHOGGOTH_PROVISION_SECRET || "";

/** In-memory message displayed by the demo service. */
let message = "Hello from the Shoggoth demo service!";

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

/** Identity handler using service-auth. */
const identityHandler = createIdentityHandler({
  provisionSecret: PROVISION_SECRET || undefined,
  onReceive(identity: string) {
    storedIdentity = identity;
    try {
      writeFileSync(KEY_PATH, identity, "utf-8");
    } catch {
      // Ignore write errors (e.g. read-only filesystem)
    }
  },
});

/** Service manifest returned at GET /manifest. */
const manifest = {
  name: "demo",
  version: "1.0.0",
  tools: [
    {
      name: "demo.set_message",
      description:
        "Set the message displayed by the demo web service. Visit the service URL to see the current message.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The new message to display",
          },
        },
        required: ["message"],
      },
      method: "POST",
      path: "/api/set_message",
      dispatch: "body",
    },
    {
      name: "demo.get_message",
      description: "Get the current message displayed by the demo web service.",
      parameters: {
        type: "object",
        properties: {},
      },
      method: "GET",
      path: "/api/get_message",
      dispatch: "body",
    },
  ],
  ops: [],
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
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

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const method = req.method?.toUpperCase() ?? "GET";

  // GET / — HTML page
  if (url.pathname === "/" && method === "GET") {
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
    return;
  }

  // GET /health — lightweight health check
  if (url.pathname === "/health" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // GET /manifest — service manifest
  if (url.pathname === "/manifest" && method === "GET") {
    json(res, 200, manifest);
    return;
  }

  // POST /_shoggoth/identity — identity provisioning
  if (url.pathname === "/_shoggoth/identity" && method === "POST") {
    const body = await readBody(req);
    let parsed: { identity?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid JSON body" });
      return;
    }

    const headers: Record<string, string | undefined> = {
      "x-provision-secret": req.headers["x-provision-secret"] as string | undefined,
      authorization: req.headers["authorization"] as string | undefined,
    };

    // Check if this is a rotation request (Bearer token with existing identity)
    const authHeader = headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ") && storedIdentity) {
      const token = authHeader.slice(7);
      const payload = await TokenValidator.validate(token, storedIdentity);
      if (payload) {
        // Valid token — allow rotation
        if (!parsed.identity) {
          json(res, 400, { error: "Missing identity in request body" });
          return;
        }
        storedIdentity = parsed.identity;
        try {
          writeFileSync(KEY_PATH, parsed.identity, "utf-8");
        } catch {
          // Ignore write errors
        }
        json(res, 200, { ok: true });
        return;
      }
      // Invalid token — fall through to provision secret check
    }

    // Use the identity handler for provision-secret-based provisioning
    try {
      const result = identityHandler({
        headers,
        body: parsed as { identity: string },
      });
      json(res, 200, result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Forbidden";
      json(res, 403, { error: msg });
    }
    return;
  }

  // Auth middleware for /api/* routes
  if (url.pathname.startsWith("/api/")) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      json(res, 401, { error: "missing or invalid authorization header" });
      return;
    }

    const token = authHeader.slice(7);
    if (!storedIdentity) {
      json(res, 401, { error: "service identity not provisioned" });
      return;
    }

    const payload = await TokenValidator.validate(token, storedIdentity);
    if (!payload) {
      json(res, 401, { error: "invalid or expired token" });
      return;
    }

    // Token is valid — proceed to route handling
  }

  // POST /api/set_message — set the message
  if (url.pathname === "/api/set_message" && method === "POST") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.message !== "string") {
        json(res, 400, { error: "message must be a string" });
        return;
      }
      message = parsed.message;
      json(res, 200, { ok: true, message });
    } catch {
      json(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  // GET /api/get_message — get the message
  if (url.pathname === "/api/get_message" && method === "GET") {
    json(res, 200, { message });
    return;
  }

  // 404
  json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error("Request error:", err);
    if (!res.headersSent) {
      json(res, 500, { error: "internal server error" });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Demo service listening on http://${HOST}:${PORT}`);
  console.log(`  Manifest: http://${HOST}:${PORT}/manifest`);
  console.log(`  Tools: demo.set_message, demo.get_message`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
