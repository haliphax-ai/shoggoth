/**
 * Operator UID → operator id / roles.
 * v1: JSON file from config path; DB-backed map can implement same interface later.
 */

import { readFileSync } from "node:fs";
import type { OperatorPrincipal, PeerCredentials } from "./principal";

export type OperatorEntry = {
  operatorId: string;
  roles: string[];
};

export type OperatorMapFile = {
  /** If set, used when byUid has no entry for the peer UID */
  defaultOperator?: OperatorEntry;
  /** Keys are decimal UID strings */
  byUid?: Record<string, OperatorEntry>;
};

export type OperatorMap = {
  resolve(uid: number): OperatorEntry | null;
};

function normalizeUidKey(uid: number): string {
  return String(Math.trunc(uid));
}

export function parseOperatorMapJson(text: string): OperatorMapFile {
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== "object")
    throw new Error("operator map: root must be an object");
  return data as OperatorMapFile;
}

export function operatorMapFromFileJson(parsed: OperatorMapFile): OperatorMap {
  const byUid = parsed.byUid ?? {};
  return {
    resolve(uid: number): OperatorEntry | null {
      const key = normalizeUidKey(uid);
      const hit = byUid[key];
      if (hit) return { ...hit, roles: [...hit.roles] };
      if (parsed.defaultOperator)
        return {
          operatorId: parsed.defaultOperator.operatorId,
          roles: [...parsed.defaultOperator.roles],
        };
      return null;
    },
  };
}

export function loadOperatorMapFromPath(path: string): OperatorMap {
  const text = readFileSync(path, "utf8");
  return operatorMapFromFileJson(parseOperatorMapJson(text));
}

export function operatorPrincipalFromPeer(
  peer: PeerCredentials,
  map: OperatorMap,
  source: "cli_socket" | "cli_operator_token" = "cli_socket",
): OperatorPrincipal | null {
  const entry = map.resolve(peer.uid);
  if (!entry) return null;
  return {
    kind: "operator",
    operatorId: entry.operatorId,
    roles: entry.roles,
    source,
    peer,
  };
}

/** Try maps in order; first non-null entry wins (SQLite → layered config → file → default). */
export function chainOperatorMaps(maps: readonly OperatorMap[]): OperatorMap {
  return {
    resolve(uid: number): OperatorEntry | null {
      for (const m of maps) {
        const e = m.resolve(uid);
        if (e) return { ...e, roles: [...e.roles] };
      }
      return null;
    },
  };
}
