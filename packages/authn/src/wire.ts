/**
 * JSONL request/response envelopes for the control wire.
 */

import type { WireAuth } from "./wire-auth";

export const WIRE_VERSION = 1 as const;

export type WireRequest = {
  v: typeof WIRE_VERSION;
  id: string;
  op: string;
  auth: WireAuth;
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
  constructor(message: string, lineText?: string) {
    super(message);
    this.lineText = lineText;
  }
}

export function parseRequestLine(line: string): WireRequest {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) throw new WireParseError("empty line");
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new WireParseError(
      `invalid json: ${e instanceof Error ? e.message : String(e)}`,
      trimmed,
    );
  }
  if (!obj || typeof obj !== "object")
    throw new WireParseError("request must be a JSON object");
  const r = obj as Record<string, unknown>;
  if (r.v !== WIRE_VERSION)
    throw new WireParseError(`unsupported wire version: ${String(r.v)}`);
  if (typeof r.id !== "string" || !r.id)
    throw new WireParseError("missing request id");
  if (typeof r.op !== "string" || !r.op)
    throw new WireParseError("missing op");
  if (!r.auth || typeof r.auth !== "object")
    throw new WireParseError("missing auth");
  const auth = r.auth as Record<string, unknown>;
  const kind = auth.kind;
  if (kind !== "operator_peercred" && kind !== "operator_token" && kind !== "agent") {
    throw new WireParseError(`unknown auth.kind: ${String(kind)}`);
  }
  if (kind === "operator_token") {
    if (typeof auth.token !== "string" || !auth.token)
      throw new WireParseError("operator_token requires auth.token");
  }
  if (kind === "agent") {
    if (typeof auth.session_id !== "string" || !auth.session_id)
      throw new WireParseError("agent auth requires auth.session_id");
    if (typeof auth.token !== "string" || !auth.token)
      throw new WireParseError("agent auth requires auth.token");
  }
  return r as unknown as WireRequest;
}

export function serializeResponse(res: WireResponse): string {
  return `${JSON.stringify(res)}\n`;
}

export function parseResponseLine(line: string): WireResponse {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) throw new WireParseError("empty line");
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new WireParseError(
      `invalid json: ${e instanceof Error ? e.message : String(e)}`,
      trimmed,
    );
  }
  if (!obj || typeof obj !== "object")
    throw new WireParseError("response must be a JSON object");
  const r = obj as Record<string, unknown>;
  if (r.v !== WIRE_VERSION)
    throw new WireParseError(`unsupported wire version: ${String(r.v)}`);
  if (typeof r.id !== "string" || !r.id)
    throw new WireParseError("missing response id");
  if (typeof r.ok !== "boolean") throw new WireParseError("missing ok boolean");
  if (r.ok === true && r.error !== undefined)
    throw new WireParseError("ok:true must not include error");
  if (r.ok === false && (r.error === undefined || typeof r.error !== "object"))
    throw new WireParseError("ok:false requires error object");
  return r as unknown as WireResponse;
}
