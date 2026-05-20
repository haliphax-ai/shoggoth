#!/usr/bin/env tsx
/**
 * Standalone managed service entrypoint for the demo service.
 *
 * Run with: npx tsx packages/service-demo/src/server.ts [port]
 *
 * Exposes:
 *   GET  /           — HTML page showing current message
 *   GET  /manifest   — Service manifest for Shoggoth discovery
 *   POST /api/set_message  — Set the displayed message
 *   GET  /api/get_message  — Get the current message
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.DEMO_SERVICE_PORT) || Number(process.argv[2]) || 3200;
const HOST = process.env.DEMO_SERVICE_HOST || "127.0.0.1";

/** In-memory message displayed by the demo service. */
let message = "Hello from the Shoggoth demo service!";

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

  // GET /manifest — service manifest
  if (url.pathname === "/manifest" && method === "GET") {
    json(res, 200, manifest);
    return;
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
