/**
 * Shoggoth session ids are URNs so future resource types can coexist:
 * - Top-level: `agent:<agentId>:<platform>:<leaf>` — `leaf` is an **opaque** platform-defined id
 *   that must pass {@link isValidSessionUrnTailSegment} (portable charset/length only).
 * - Subagent: `agent:<agentId>:<platform>:<parentLeaf>:<childLeaf>:…` (same rules per segment).
 *
 * **Platform bridges** must validate their own tail shapes (identifiers, UUIDs, etc.)
 * before trusting a route; core only enforces structure so new platforms can ship as plugins.
 *
 * `agentId` matches {@link assertValidAgentId} (no colons). `platform` is a short bridge name (e.g. `discord`).
 */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";


/** RFC 4122 UUID string (case-insensitive). */
export const SHOGGOTH_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Portable tail segment: no colons, bounded length, safe for logs and URLs.
 * Per-platform validators may impose stricter rules.
 */
export const SHOGGOTH_SESSION_URN_TAIL_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Reserved UUID for the default primary session when bootstrap has no platform-specific session key.
 */
export const SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID = "00000000-0000-4000-8000-000000000001";

export function assertValidAgentId(agentId: string): void {
  const t = agentId.trim();
  if (!t) throw new Error("agentId must be non-empty");
  if (t === "." || t === "..") throw new Error(`invalid agentId: ${JSON.stringify(agentId)}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(t)) {
    throw new Error(`agentId must match /^[a-zA-Z0-9._-]+$/: ${JSON.stringify(agentId)}`);
  }
}

/** Workspace directory for an agent: `{workspacesRoot}/{agentId}`. */
export function resolveAgentWorkspacePath(workspacesRoot: string, agentId: string): string {
  assertValidAgentId(agentId);
  const root = workspacesRoot.trim();
  if (!root) throw new Error("workspacesRoot must be non-empty");
  return resolve(join(root, agentId.trim()));
}

export type ParsedAgentSessionUrn = {
  readonly agentId: string;
  readonly platform: string;
  /** Segments after `platform` (opaque per platform; one = top-level; two+ = subagent chain). */
  readonly uuidChain: readonly string[];
};

export function isValidSessionUrnTailSegment(seg: string): boolean {
  return SHOGGOTH_SESSION_URN_TAIL_SEGMENT_RE.test(seg.trim());
}

function normalizeSessionUrnTailSegment(seg: string): string {
  const s = seg.trim();
  return SHOGGOTH_SESSION_UUID_RE.test(s) ? s.toLowerCase() : s;
}

/**
 * Parses `agent:<agentId>:<platform>:<leaf>` or
 * `agent:<agentId>:<platform>:<parent leaf>:<child leaf>:…`.
 */
export function parseAgentSessionUrn(id: string): ParsedAgentSessionUrn | null {
  const t = id.trim();
  if (!t.startsWith("agent:")) return null;
  const rest = t.slice("agent:".length);
  const c0 = rest.indexOf(":");
  if (c0 < 0) return null;
  const agentId = rest.slice(0, c0);
  const rest1 = rest.slice(c0 + 1);
  const c1 = rest1.indexOf(":");
  if (c1 < 0) return null;
  const platform = rest1.slice(0, c1);
  const tail = rest1.slice(c1 + 1);
  if (!tail) return null;
  try {
    assertValidAgentId(agentId);
  } catch {
    return null;
  }
  if (!platform.trim()) return null;
  const uuidChain = tail.split(":");
  if (uuidChain.length < 1) return null;
  for (const u of uuidChain) {
    if (!isValidSessionUrnTailSegment(u)) return null;
  }
  return {
    agentId: agentId.trim(),
    platform: platform.trim(),
    uuidChain: uuidChain.map(normalizeSessionUrnTailSegment),
  };
}

export function isValidAgentSessionUrn(id: string): boolean {
  return parseAgentSessionUrn(id) !== null;
}

/** True when the URN has more than one tail segment after `platform` (a child of a top-level session). */
export function isSubagentSessionUrn(id: string): boolean {
  const p = parseAgentSessionUrn(id);
  return p !== null && p.uuidChain.length > 1;
}

/**
 * For a subagent URN (`agent:<agentId>:<platform>:<parentLeaf>:<childUuid>`),
 * returns the top-level session URN (`agent:<agentId>:<platform>:<parentLeaf>`).
 * Returns `null` when the id is not a subagent URN (already top-level or invalid).
 */
export function resolveTopLevelSessionUrn(id: string): string | null {
  const p = parseAgentSessionUrn(id);
  if (!p || p.uuidChain.length <= 1) return null;
  return `agent:${p.agentId}:${p.platform}:${p.uuidChain[0]}`;
}

export function formatAgentSessionUrn(agentId: string, platform: string, sessionLeaf: string): string {
  assertValidAgentId(agentId);
  const plat = platform.trim();
  if (!plat) throw new Error("platform must be non-empty");
  const leaf = sessionLeaf.trim();
  if (!isValidSessionUrnTailSegment(leaf)) {
    throw new Error(`sessionLeaf must be a valid URN tail segment: ${JSON.stringify(sessionLeaf)}`);
  }
  return `agent:${agentId.trim()}:${plat}:${normalizeSessionUrnTailSegment(leaf)}`;
}

/**
 * Subagent session: `agent:<agentId>:<platform>:<parent-leaf>:<new uuid>`.
 * Parent leaf is the last segment in the parent URN chain. New segment is always a UUID.
 */
export function mintSubagentSessionUrnFromParent(parentSessionId: string, subUuid?: string): string {
  const p = parseAgentSessionUrn(parentSessionId);
  if (!p) throw new Error(`invalid parent session URN: ${JSON.stringify(parentSessionId)}`);
  const parentLeaf = p.uuidChain[p.uuidChain.length - 1]!;
  const subRaw = (subUuid ?? randomUUID()).trim();
  if (!SHOGGOTH_SESSION_UUID_RE.test(subRaw)) throw new Error("invalid subUuid");
  const sub = subRaw.toLowerCase();
  return `agent:${p.agentId}:${p.platform}:${parentLeaf}:${sub}`;
}

export function mintAgentSessionUrn(agentId: string, platform: string): string {
  return formatAgentSessionUrn(agentId, platform, randomUUID());
}

/** Primary session URN for bootstrap when no platform-specific key is supplied (daemon resolves via registered per-platform URN policy). */
export function defaultPrimarySessionUrnForAgent(
  agentId: string,
  platform: string,
): string {
  return formatAgentSessionUrn(agentId, platform, SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
}


