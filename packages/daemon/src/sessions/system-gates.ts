// ---------------------------------------------------------------------------
// Configurable system gates — apply the AGENTS.md discovery gate and the
// re-read-required gate to configured external (MCP) tool names.
//
// The two gates are hard-wired into specific builtin handlers; this module
// reuses the same gate functions (`checkAgentsMdGate`, `checkReReadRequired`,
// `markReReadRequired`) for any tool whose namespaced name matches
// `config.gates.<gate>.tools` globs.
//
// The factory is built once per turn (closes over session context) and exposes
// a pre/post hook consumed by the tool loop:
//   - `pre` runs BEFORE HITL: AGENTS.md discovery + re-read consumer; returns
//     a `{ resultJson }` payload to short-circuit with, or null to proceed.
//   - `post` runs after successful execution: re-read producer (line-count
//     snapshot around the call), mirroring the builtin-replace producer.
//
// A gate must never fail a tool call: all hook bodies degrade to no-ops on
// internal errors (logged via the "system-gates" logger).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { toolIdGlobMatches } from "./tool-id-glob";
import { checkAgentsMdGate } from "./agents-md-gate";
import { checkReReadRequired, markReReadRequired } from "./re-read-required";
import { getLogger } from "../logging";

export interface SystemGatesDeps {
  readonly db: Database.Database;
  readonly sessionId: string;
  readonly contextSegmentId: string;
  readonly workspacePath: string;
  /** Read `config.gates` (tolerate undefined). */
  readonly config: ShoggothConfig;
  /** Fresh per call (cd visibility mid-turn). */
  readonly getWorkingDirectory: () => string | undefined;
}

export interface SystemGatesHook {
  /** Returns a gate resultJson to short-circuit with, or null to proceed. Runs BEFORE HITL. */
  pre(input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
  }): Promise<{ resultJson: string } | null>;
  /** Post-execution producer (re-read marking). Must never throw. */
  post(input: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    resultJson: string;
  }): Promise<void>;
}

const log = getLogger("system-gates");

const GATE_TOOL_LIST_DEFAULT: readonly string[] = [];

/**
 * Structural slice of the gates config. Read defensively: daemon tsc may
 * resolve `@shoggoth/shared` to a build that predates the `gates` field, in
 * which case `ShoggothConfig` has no `gates` property. Accessing it through
 * this shape compiles against both old and new shared types and degrades to
 * empty lists at runtime when the section is absent.
 */
interface GatesConfigSlice {
  readonly agentsMd?: { readonly tools?: readonly string[] };
  readonly reRead?: { readonly tools?: readonly string[] };
}

/** True when any pattern in `patterns` matches `toolName`. */
function matchesAny(pattern: readonly string[] | undefined, toolName: string): boolean {
  if (!pattern || pattern.length === 0) return false;
  return pattern.some((p) => toolIdGlobMatches(p, toolName));
}

/** Recursively collect every string value in `value` (best-effort path scan). */
function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStringValues(v, out);
  }
}

/** Count lines using the same split as `replace-handler.ts` (`builtin-read`). */
function countLines(text: string): number {
  return text.split(/\r\n|\n|\r/).length;
}

/**
 * Resolve candidate file paths from tool args against the working directory,
 * keeping only paths inside the workspace (security boundary). Best-effort:
 * any string value in args is treated as a candidate path.
 */
function candidatePaths(
  args: Record<string, unknown>,
  cwd: string | undefined,
  workspacePath: string,
): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const strings: string[] = [];
  collectStringValues(args, strings);
  const out: string[] = [];
  for (const raw of strings) {
    if (!raw) continue;
    const abs = isAbsolute(raw) ? raw : resolve(cwd ?? workspacePath, raw);
    if (!abs.startsWith(workspacePath)) continue;
    if (out.includes(abs)) continue;
    out.push(abs);
  }
  return out;
}

export function createSystemGates(deps: SystemGatesDeps): SystemGatesHook {
  const gates = (deps.config as { gates?: GatesConfigSlice }).gates;
  const agentsMdPatterns = gates?.agentsMd?.tools ?? GATE_TOOL_LIST_DEFAULT;
  const reReadPatterns = gates?.reRead?.tools ?? GATE_TOOL_LIST_DEFAULT;

  // toolCallId -> snapshot of candidate file line counts taken in `pre`.
  // Consumed (and always deleted) by `post`, also deleted on `post` failure.
  const snapshots = new Map<string, Map<string, number>>();

  return {
    async pre({ toolName, args, toolCallId }) {
      const cwd = deps.getWorkingDirectory() ?? deps.workspacePath;

      // ---- AGENTS.md discovery gate ----
      if (matchesAny(agentsMdPatterns, toolName)) {
        const gate = checkAgentsMdGate(deps.db, deps.sessionId, cwd, deps.workspacePath);
        if (gate) return { resultJson: JSON.stringify(gate) };
      }

      // ---- re-read-required consumer ----
      if (matchesAny(reReadPatterns, toolName)) {
        const candidates = candidatePaths(args, cwd, deps.workspacePath);
        if (candidates.length > 0) {
          // Snapshot line counts for the producer (best-effort; files that do
          // not exist or cannot be read are skipped).
          const snapshot = new Map<string, number>();
          for (const abs of candidates) {
            const gate = checkReReadRequired(deps.db, deps.sessionId, deps.contextSegmentId, abs);
            if (gate) return { resultJson: JSON.stringify(gate) };
            try {
              if (existsSync(abs)) {
                snapshot.set(abs, countLines(readFileSync(abs, "utf8")));
              }
            } catch {
              // skip unreadable candidates
            }
          }
          if (snapshot.size > 0) snapshots.set(toolCallId, snapshot);
        }
      }

      return null;
    },

    async post({ toolName, args: _args, toolCallId }) {
      const snapshot = snapshots.get(toolCallId);
      if (!snapshot) return;
      snapshots.delete(toolCallId);

      if (!matchesAny(reReadPatterns, toolName)) return;

      try {
        for (const [absPath, before] of snapshot) {
          if (!existsSync(absPath)) continue;
          const after = countLines(readFileSync(absPath, "utf8"));
          if (after === before) continue;
          markReReadRequired(deps.db, deps.sessionId, deps.contextSegmentId, absPath);
        }
      } catch (e) {
        log.warn("re-read producer failed; skipping", {
          sessionId: deps.sessionId,
          toolName,
          toolCallId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
