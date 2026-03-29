#!/usr/bin/env node
/**
 * Loopback HTTP → Shoggoth control socket bridge for canvas_authorize.
 * See docs/canvas.md.
 */

import { createConnection } from "node:net";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildCanvasAuthorizeLine, parseWireResponseLine, toAuthorizeHttpBody } from "./wire.mjs";

function getSocketPath() {
  const p = process.env.SHOGGOTH_CONTROL_SOCKET;
  if (!p?.trim()) {
    throw new Error("SHOGGOTH_CONTROL_SOCKET is required");
  }
  return p.trim();
}

function readFirstLine(socket) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        cleanup();
        resolve(buf.slice(0, i));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}

/**
 * @param {string} socketPath
 * @param {string} line
 */
export function forwardLineToControlSocket(socketPath, line) {
  return new Promise((resolve, reject) => {
    const c = createConnection(socketPath);
    c.setEncoding("utf8");
    c.once("error", reject);
    readFirstLine(c)
      .then((out) => {
        c.end();
        resolve(out);
      })
      .catch(reject);
    c.once("connect", () => {
      c.write(line, "utf8");
    });
  });
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function startCanvasAuthorizeHookServer(options) {
  const socketPath = options?.socketPath ?? getSocketPath();
  const host = options?.host ?? process.env.CANVAS_AUTHORIZE_HOOK_HOST ?? "127.0.0.1";
  const port = Number(options?.port ?? process.env.CANVAS_AUTHORIZE_HOOK_PORT ?? "18081");

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body;
    try {
      body = await jsonBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json body" }));
      return;
    }
    if (!body || typeof body !== "object") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "expected json object body" }));
      return;
    }
    let line;
    try {
      line = buildCanvasAuthorizeLine(/** @type {any} */ (body));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    let outLine;
    try {
      outLine = await forwardLineToControlSocket(socketPath, line);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    let wire;
    try {
      wire = parseWireResponseLine(outLine);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    const mapped = toAuthorizeHttpBody(wire);
    res.writeHead(mapped.httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mapped.body));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => resolve({ server, socketPath, host, port }));
    server.on("error", reject);
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const socketPath = getSocketPath();
  startCanvasAuthorizeHookServer({ socketPath })
    .then(({ host, port }) => {
      console.error(
        `[canvas-authorize-hook] listening http://${host}:${port} → ${socketPath} (POST /)`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
