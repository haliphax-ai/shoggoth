/**
 * Session id URN grammar: `agent:<agentId>:<platform>:<resourceType>:<leaf>`
 * (top-level), with `:<childLeaf>:…` appended for subagent chains. `leaf` is
 * an opaque platform-defined segment passing {@link isValidSessionUrnTailSegment};
 * `agentId` must pass {@link assertValidAgentId}. Segment rules and the
 * bridge-validation contract: docs/shared.md — "Session URNs".
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
  /** Resource type segment (e.g. "channel", "subagent", "dm"). */
  readonly resourceType: string;
  /** Segments after `resourceType` (opaque per platform; one = top-level; two+ = subagent chain). */
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
 * Parses `agent:<agentId>:<platform>:<resourceType>:<leaf>` or
 * `agent:<agentId>:<platform>:<resourceType>:<parent leaf>:<child leaf>:…`.
 */
export function parseAgentSessionUrn(id: string): ParsedAgentSessionUrn | null {
  const t = id.trim();
  if (!t.startsWith("agent:")) return null;
  const rest = t.slice("agent:".length);
  // Split into segments: agentId, platform, resourceType, leaf[, childLeaf, ...]
  const segments = rest.split(":");
  // Minimum 4 segments: agentId, platform, resourceType, leaf
  if (segments.length < 4) return null;
  const [agentId, platform, resourceType, ...tailSegments] = segments;
  if (!agentId || !platform || !resourceType || tailSegments.length < 1) return null;
  try {
    assertValidAgentId(agentId);
  } catch {
    return null;
  }
  if (!platform.trim()) return null;
  if (!isValidSessionUrnTailSegment(resourceType)) return null;
  for (const u of tailSegments) {
    if (!isValidSessionUrnTailSegment(u)) return null;
  }
  return {
    agentId: agentId.trim(),
    platform: platform.trim(),
    resourceType: resourceType.trim(),
    uuidChain: tailSegments.map(normalizeSessionUrnTailSegment),
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
 * For a subagent URN (`agent:<agentId>:<platform>:<resourceType>:<parentLeaf>:<childUuid>`),
 * returns the top-level session URN (`agent:<agentId>:<platform>:<resourceType>:<parentLeaf>`).
 * Returns `null` when the id is not a subagent URN (already top-level or invalid).
 */
export function resolveTopLevelSessionUrn(id: string): string | null {
  const p = parseAgentSessionUrn(id);
  if (!p || p.uuidChain.length <= 1) return null;
  return `agent:${p.agentId}:${p.platform}:${p.resourceType}:${p.uuidChain[0]}`;
}

export function formatAgentSessionUrn(
  agentId: string,
  platform: string,
  resourceType: string,
  sessionLeaf: string,
): string {
  assertValidAgentId(agentId);
  const plat = platform.trim();
  if (!plat) throw new Error("platform must be non-empty");
  const rt = resourceType.trim();
  if (!isValidSessionUrnTailSegment(rt)) {
    throw new Error(
      `resourceType must be a valid URN tail segment: ${JSON.stringify(resourceType)}`,
    );
  }
  const leaf = sessionLeaf.trim();
  if (!isValidSessionUrnTailSegment(leaf)) {
    throw new Error(`sessionLeaf must be a valid URN tail segment: ${JSON.stringify(sessionLeaf)}`);
  }
  return `agent:${agentId.trim()}:${plat}:${rt}:${normalizeSessionUrnTailSegment(leaf)}`;
}

/**
 * Subagent session: `agent:<agentId>:<platform>:<resourceType>:<parent-leaf>:<new uuid>`.
 * Parent leaf is the last segment in the parent URN chain. New segment is always a UUID.
 * Resource type is preserved from the parent URN.
 */
export function mintSubagentSessionUrnFromParent(
  parentSessionId: string,
  subUuid?: string,
): string {
  const p = parseAgentSessionUrn(parentSessionId);
  if (!p) throw new Error(`invalid parent session URN: ${JSON.stringify(parentSessionId)}`);
  const parentLeaf = p.uuidChain[p.uuidChain.length - 1]!;
  const subRaw = (subUuid ?? randomUUID()).trim();
  if (!SHOGGOTH_SESSION_UUID_RE.test(subRaw)) throw new Error("invalid subUuid");
  const sub = subRaw.toLowerCase();
  return `agent:${p.agentId}:${p.platform}:${p.resourceType}:${parentLeaf}:${sub}`;
}

export function mintAgentSessionUrn(
  agentId: string,
  platform: string,
  resourceType: string,
): string {
  return formatAgentSessionUrn(agentId, platform, resourceType, randomUUID());
}

/** Primary session URN for bootstrap when no platform-specific key is supplied (daemon resolves via registered per-platform URN policy). */
export function defaultPrimarySessionUrnForAgent(
  agentId: string,
  platform: string,
  resourceType: string,
): string {
  return formatAgentSessionUrn(
    agentId,
    platform,
    resourceType,
    SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  );
}
