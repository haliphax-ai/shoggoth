/**
 * JSONL wire helpers for canvas_authorize (mirror @shoggoth/authn v1 envelope).
 */

export const WIRE_VERSION = 1;

/**
 * @param {{ id: string, auth: Record<string, unknown>, payload: { action: string, resource_session_id: string } }} input
 */
export function buildCanvasAuthorizeLine(input) {
  if (!input?.id || typeof input.id !== "string") {
    throw new TypeError("input.id must be a non-empty string");
  }
  if (!input.auth || typeof input.auth !== "object") {
    throw new TypeError("input.auth must be an object");
  }
  const { action, resource_session_id: resourceSessionId } = input.payload ?? {};
  if (typeof action !== "string" || !action.trim()) {
    throw new TypeError("payload.action must be a non-empty string");
  }
  if (typeof resourceSessionId !== "string" || !resourceSessionId.trim()) {
    throw new TypeError("payload.resource_session_id must be a non-empty string");
  }
  const req = {
    v: WIRE_VERSION,
    id: input.id,
    op: "canvas_authorize",
    auth: input.auth,
    payload: {
      action,
      resource_session_id: resourceSessionId,
    },
  };
  return `${JSON.stringify(req)}\n`;
}

/**
 * @param {string} line
 * @returns {{ ok: boolean, id: string, result?: unknown, error?: { code: string, message: string } }}
 */
export function parseWireResponseLine(line) {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) {
    throw new SyntaxError("empty response line");
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new SyntaxError(`invalid json: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new TypeError("response must be an object");
  }
  if (obj.v !== WIRE_VERSION) {
    throw new TypeError(`unsupported wire version: ${String(obj.v)}`);
  }
  if (typeof obj.id !== "string") {
    throw new TypeError("missing response id");
  }
  if (typeof obj.ok !== "boolean") {
    throw new TypeError("missing ok boolean");
  }
  return obj;
}

/**
 * Map wire response to HTTP-friendly authorize result.
 * @param {ReturnType<typeof parseWireResponseLine>} wire
 */
export function toAuthorizeHttpBody(wire) {
  if (!wire.ok) {
    const code = wire.error?.code ?? "wire_error";
    const message = wire.error?.message ?? "control plane error";
    return { ok: false, httpStatus: 502, body: { error: `${code}: ${message}` } };
  }
  const r = wire.result;
  if (!r || typeof r !== "object") {
    return { ok: false, httpStatus: 502, body: { error: "missing result" } };
  }
  const rec = /** @type {Record<string, unknown>} */ (r);
  if (rec.allow === true) {
    return { ok: true, httpStatus: 200, body: { allow: true } };
  }
  if (rec.allow === false && typeof rec.reason === "string") {
    return { ok: true, httpStatus: 200, body: { allow: false, reason: rec.reason } };
  }
  return { ok: false, httpStatus: 502, body: { error: "unexpected result shape" } };
}
