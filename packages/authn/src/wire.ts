/**
 * JSONL request/response envelopes for the control wire.
 */

import type { WireAuth } from "./wire-auth";

export const WIRE_VERSION = 1 as const;

export type WireRequest = {
  v: typeof WIRE_VERSION;
  id: string;
  op: string;
  auth?: WireAuth;
  payload?: unknown;
};

export type WireErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export type WireResponse = {
  v: typeof WIRE_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireErrorBody;
};

export class WireParseError extends Error {
  override name = "WireParseError";
  readonly lineText?: string;
  /**
   * 0-based index of the line in the stream, when the caller knows it. Not set
   * by the parse functions themselves (they see only a single line) — stream
   * consumers attach their own position here for debugging.
   */
  readonly lineNumber?: number;
  constructor(message: string, lineText?: string, lineNumber?: number) {
    super(message);
    this.lineText = lineText;
    this.lineNumber = lineNumber;
  }
}

/**
 * Internal throw helper: builds a WireParseError, attaching the optional line
 * number so every error from a stream-aware parse carries its position.
 */
function err(message: string, lineNumber?: number, lineText?: string): WireParseError {
  return new WireParseError(message, lineText, lineNumber);
}

/**
 * Shared preprocessing for JSONL wire lines: strip a trailing CR, guard against
 * empty lines, and parse the JSON payload.
 */
function parseJsonLine(
  line: string,
  lineNumber: number | undefined,
): { obj: unknown; trimmed: string } {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) throw err("empty line", lineNumber);
  try {
    return { obj: JSON.parse(trimmed), trimmed };
  } catch (e) {
    throw err(`invalid json: ${e instanceof Error ? e.message : String(e)}`, lineNumber, trimmed);
  }
}

export function parseRequestLine(line: string, lineNumber?: number): WireRequest {
  const { obj } = parseJsonLine(line, lineNumber);
  if (!obj || typeof obj !== "object") throw err("request must be a JSON object", lineNumber);
  const r = obj as Record<string, unknown>;
  if (r.v !== WIRE_VERSION) throw err(`unsupported wire version: ${String(r.v)}`, lineNumber);
  if (typeof r.id !== "string" || !r.id) throw err("missing request id", lineNumber);
  // `op` is deliberately left format-free: it is an opaque dispatch label, not
  // a path or identifier. Every dispatch site matches it against fixed,
  // literal op names (daemon control-plane `dispatchOp`, policy
  // `isDefinedControlOp`, `handleIntegrationControlOp`) and rejects anything
  // unrecognized with ERR_UNKNOWN_OP before a handler runs. Do not add
  // consumers that index, resolve, or interpolate `op` — keep dispatch
  // exact-match only.
  if (typeof r.op !== "string" || !r.op) throw err("missing op", lineNumber);
  // Auth is optional — ops like "health" are exempt
  if (r.auth && typeof r.auth === "object") {
    const auth = r.auth as Record<string, unknown>;
    const kind = auth.kind;
    if (kind !== "operator_token" && kind !== "agent") {
      throw err(`unknown auth.kind: ${String(kind)}`, lineNumber);
    }
    if (kind === "operator_token") {
      if (typeof auth.token !== "string" || !auth.token)
        throw err("operator_token requires auth.token", lineNumber);
    }
    if (kind === "agent") {
      if (typeof auth.session_id !== "string" || !auth.session_id)
        throw err("agent auth requires auth.session_id", lineNumber);
      if (typeof auth.token !== "string" || !auth.token)
        throw err("agent auth requires auth.token", lineNumber);
    }
  }

  return r as unknown as WireRequest;
}

export function serializeResponse(res: WireResponse): string {
  return `${JSON.stringify(res)}\n`;
}

export function parseResponseLine(line: string, lineNumber?: number): WireResponse {
  const { obj } = parseJsonLine(line, lineNumber);
  if (!obj || typeof obj !== "object") throw err("response must be a JSON object", lineNumber);
  const r = obj as Record<string, unknown>;
  if (r.v !== WIRE_VERSION) throw err(`unsupported wire version: ${String(r.v)}`, lineNumber);
  if (typeof r.id !== "string" || !r.id) throw err("missing response id", lineNumber);
  if (typeof r.ok !== "boolean") throw err("missing ok boolean", lineNumber);
  if (r.ok === true && r.error !== undefined)
    throw err("ok:true must not include error", lineNumber);
  if (r.ok === false && (r.error === undefined || typeof r.error !== "object"))
    throw err("ok:false requires error object", lineNumber);
  return r as unknown as WireResponse;
}
