import { readFileSync } from "node:fs";

const FALLBACK_AGENT_ID = 900;

/**
 * Read the `agent:` account from `/etc/passwd`, returning `undefined` when the
 * file is unreadable or the account is missing/malformed.
 */
export function readAgentPasswdCreds(): { uid: number; gid: number } | undefined {
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith("agent:"));
    if (!line) return undefined;
    const fields = line.split(":");
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0) {
      return { uid, gid };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the agent UID/GID for spawning agent-owned processes.
 *
 * Resolution order:
 * 1. `SHOGGOTH_AGENT_UID` environment variable (explicit deployment config).
 * 2. The `agent:` account line in `/etc/passwd` (canonical system identity).
 * 3. 900 (the default build-time value).
 *
 * The agent user always has matching UID and GID.
 */
export function resolveAgentCreds(env: NodeJS.ProcessEnv = process.env): {
  uid: number;
  gid: number;
} {
  const raw = env.SHOGGOTH_AGENT_UID;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return { uid: parsed, gid: parsed };
  }
  return readAgentPasswdCreds() ?? { uid: FALLBACK_AGENT_ID, gid: FALLBACK_AGENT_ID };
}
