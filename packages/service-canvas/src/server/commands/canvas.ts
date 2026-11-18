import type { Gateway } from "../services/gateway";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Upper bound for client-provided session identifiers and canvas paths.
 * Keeps a single oversized message from fanning out to every connected SPA.
 */
const MAX_INPUT_LENGTH = 512;

function isValidSession(v: unknown): v is string {
  if (!isNonEmptyString(v) || v.length > MAX_INPUT_LENGTH) return false;
  // The SPA mounts each session at /:session, and internal URLs are built by
  // string concatenation, so a session ID containing a separator can never
  // resolve to a real session route.
  return !v.includes("/");
}

/**
 * Normalize an in-canvas navigation path, or return null when it must be
 * rejected. Only relative paths that stay inside the canvas SPA are allowed:
 * leading slashes, backslashes, NUL bytes, and `..` segments are stripped or
 * rejected so the SPA router never escapes its own route space.
 */
function sanitizePath(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_INPUT_LENGTH) return null;
  const normalized = v.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.includes("\0")) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  return normalized;
}

export function registerCanvasCommands(gateway: Gateway) {
  gateway.on("canvas.show", (msg, reply) => {
    if (!isValidSession(msg.session)) {
      reply({ error: "Invalid session" });
      return;
    }
    const session = msg.session;
    gateway.setActiveSession(session);
    gateway.broadcastSpaSession(session, { type: "canvas.show", session });

    // `target` and `surface` arrive from the canvas-present tool, but the SPA
    // acts only on `session`; they are deliberately not forwarded.
    void msg.target;
    void msg.surface;
    reply({ ok: true, session });
  });

  gateway.on("canvas.hide", (_msg, reply) => {
    gateway.broadcastSpa({ type: "canvas.hide" });
    reply({ ok: true });
  });

  gateway.on("canvas.navigate", (msg, reply) => {
    if (!isValidSession(msg.session)) {
      reply({ error: "Invalid session" });
      return;
    }
    const path = sanitizePath(msg.path);
    if (path === null) {
      reply({ error: "Invalid path" });
      return;
    }
    const session = msg.session;
    gateway.setActiveSession(session);
    gateway.broadcastSpaSession(session, { type: "canvas.navigate", session, path });
    reply({ ok: true, session, path });
  });

  gateway.on("canvas.navigateExternal", (msg, reply) => {
    const url = msg.url;
    if (!isNonEmptyString(url) || !(url.startsWith("http://") || url.startsWith("https://"))) {
      reply({ error: "Invalid URL — only http(s) allowed" });
      return;
    }
    gateway.broadcastSpa({ type: "canvas.navigateExternal", url });
    reply({ ok: true, url });
  });

  gateway.on("canvas.eval", (msg, reply) => {
    if (!isNonEmptyString(msg.js)) {
      reply({ error: "Missing js field" });
      return;
    }
    gateway.broadcastSpa({ type: "canvas.eval", js: msg.js, id: msg.id });
    reply({ ok: true, note: "eval dispatched to SPA" });
  });

  gateway.on("canvas.snapshot", async (msg, reply) => {
    const id = isNonEmptyString(msg.id) ? msg.id : `snap_${Date.now()}`;
    const result = await gateway.requestSnapshot(id);
    reply(result);
  });
}
