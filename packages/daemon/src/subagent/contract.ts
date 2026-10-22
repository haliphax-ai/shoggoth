// ---------------------------------------------------------------------------
// Contract mode for one-shot subagent spawns.
//
// A spawn-time `contract` is a list of target files/folders with the required
// modification type (create, update, delete) and a brief summary of the
// expected change. When active:
//
// 1. All targets must live inside a git repository at call time (validated
//    before the child session is created — a failure aborts the spawn).
// 2. After the turn, a target not acted upon with its contractual type is a
//    structural contract break (no decision call is made for it).
// 3. Otherwise the per-file `git diff` against the baseline (source branch
//    HEAD, or the spawn HEAD when there is no source branch) is judged by the
//    decision model in batches (`agents.contract.batchSize`, default 5).
//    Deleted files are not sent to the decision model.
// 4. Any per-file "yes" probability below `agents.contract.yesMinimum`
//    (default 0.85), any structural break, or any decision failure marks the
//    contract as not fulfilled.
// ---------------------------------------------------------------------------

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ShoggothConfig, ShoggothContractEntry } from "@shoggoth/shared";
import { resolveAgentCreds } from "../agent-creds.js";
import { DecisionService } from "../decision/decision-service.js";
import { getLogger } from "../logging.js";

const log = getLogger("contract");

/** Default minimum "yes" probability for a per-file contract decision. */
export const CONTRACT_YES_MINIMUM_DEFAULT = 0.85;
/** Default number of contract entries judged per decision call. */
export const CONTRACT_BATCH_SIZE_DEFAULT = 5;
/** Timeout for a single decision (batch) call. */
export const CONTRACT_JUDGE_TIMEOUT_MS = 60_000;

const CONTRACT_ACTIONS = new Set(["create", "update", "delete"]);

/**
 * Upper bound on downward repo-discovery probes (directory children probed
 * with `git rev-parse`). Keeps the nested-repo search bounded on sprawling
 * trees; a workspace's scratch repos sit within the first couple of levels.
 */
const MAX_REPO_PROBES = 512;

/**
 * Parse and validate a raw spawn-time `contract` payload. Returns `undefined`
 * when contract mode is inactive (unset or empty array); throws on malformed
 * input so callers can surface an invalid-payload error.
 */
export function parseContract(raw: unknown): ShoggothContractEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("contract must be an array");
  if (raw.length === 0) return undefined;
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`contract[${index}] must be an object`);
    }
    const e = item as Record<string, unknown>;
    const path = typeof e.path === "string" ? e.path.trim() : "";
    const action = typeof e.action === "string" ? e.action.trim() : "";
    const summary = typeof e.summary === "string" ? e.summary.trim() : "";
    if (!path) throw new Error(`contract[${index}].path must be a non-empty string`);
    if (!CONTRACT_ACTIONS.has(action)) {
      throw new Error(`contract[${index}].action must be create, update, or delete`);
    }
    if (!summary) throw new Error(`contract[${index}].summary must be a non-empty string`);
    return { path, action: action as "create" | "update" | "delete", summary };
  });
}

// Git hook / CI environments can export GIT_DIR, GIT_WORK_TREE, etc., which
// would make `git` resolve to an unrelated repository regardless of cwd.
// Contract checks must be based on the working directory alone.
const GIT_ENV_STRIP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_STRIP) delete env[key];
  return env;
}

/**
 * POSIX credentials for contract git invocations. Contract checks read and
 * diff the working tree the subagent session edits, so they must run as the
 * agent UID — the daemon's own UID would get EACCES on agent-owned workspaces
 * (and vice versa).
 */
export interface ContractCreds {
  uid: number;
  gid: number;
}

/** Fallback contract git credentials: the configured agent UID/GID. */
function defaultCreds(): ContractCreds {
  return resolveAgentCreds();
}

function gitOptions(
  cwd: string | undefined,
  creds: ContractCreds,
): ExecFileSyncOptions & { encoding: "utf8" } {
  return {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
    uid: creds.uid,
    gid: creds.gid,
  };
}

/**
 * True when spawning failed because the uid/gid switch was not permitted.
 * Covers EPERM and EACCES: the platform may reject the switch before exec or
 * at setuid inside the child, and either way the daemon simply lacks the
 * capability to become another user.
 */
function isCredsUnsupported(e: unknown): boolean {
  const err = e as { code?: unknown; error?: { code?: unknown } } | null;
  const codes = [err?.code, err?.error?.code];
  return codes.includes("EPERM") || codes.includes("EACCES");
}

/**
 * Run `git` as the resolved contract credentials.
 *
 * Two portability measures:
 *
 * - `safe.directory` is relaxed for these invocations only. Contract checks
 *   are read-only inspections of the caller's own working directory, and git
 *   otherwise refuses a repository owned by a different uid (its "dubious
 *   ownership" guard) even when DAC permissions allow reading it — which is
 *   exactly the daemon/agent uid split this feature runs under.
 * - When the switch to the target uid is not permitted (no `CAP_SETUID`, e.g.
 *   CI runners) the command is retried as the current user rather than
 *   failing every contract check outright. This applies to explicit creds
 *   too: callers always pass them, so gating the retry on an absent override
 *   would defeat it.
 */
function runGit(args: string[], cwd: string | undefined, creds?: ContractCreds): string {
  const target = creds ?? defaultCreds();
  const safeArgs = ["-c", "safe.directory=*", ...args];
  try {
    return execFileSync("git", safeArgs, gitOptions(cwd, target));
  } catch (e) {
    if (
      isCredsUnsupported(e) &&
      typeof process.getuid === "function" &&
      typeof process.getgid === "function"
    ) {
      const fallback = { uid: process.getuid(), gid: process.getgid() };
      if (fallback.uid !== target.uid || fallback.gid !== target.gid) {
        log.warn("contract_git_uid_switch_failed", {
          requestedUid: target.uid,
          requestedGid: target.gid,
          fallbackUid: fallback.uid,
          fallbackGid: fallback.gid,
        });
        return execFileSync("git", safeArgs, gitOptions(cwd, fallback));
      }
    }
    throw e;
  }
}

function git(repoDir: string, args: string[], creds?: ContractCreds): string {
  return runGit(args, repoDir, creds);
}

function tryGit(repoDir: string, args: string, creds?: ContractCreds): string | undefined {
  try {
    return git(repoDir, args.split(" "), creds);
  } catch {
    return undefined;
  }
}

/** Repository worktree root for a directory, or undefined when not a repo. */
export function repoTopLevel(cwd: string, creds?: ContractCreds): string | undefined {
  return findRepoTopLevel(cwd, cwd, creds);
}

/**
 * Discover the repository containing `start`, or undefined.
 *
 * Discovery runs in two directions because git's own discovery only ever
 * walks *upward* from its cwd:
 *
 * 1. Upward from `start` — a repo containing `start`.
 * 2. Downward from `downFrom` (BFS over directory names, probing each
 *    candidate upward) — a repo *nested below* `downFrom`. The session
 *    workspace is the natural base for this direction: a scratch repo like
 *    `workspace/tmp/contract-test` sits below the workspace root, so an
 *    upward-only probe from the root can never find it.
 *
 * With `downFrom === start` this is pure upward discovery — the historical
 * behavior.
 */
function findRepoTopLevel(
  start: string,
  downFrom: string,
  creds?: ContractCreds,
): string | undefined {
  const up = tryGit(start, "rev-parse --show-toplevel", creds)?.trim();
  if (up) return up;

  const queue: string[] = [downFrom];
  const seen = new Set<string>([downFrom]);
  let probed = 0;
  while (queue.length > 0 && probed < MAX_REPO_PROBES) {
    const dir = queue.shift()!;
    probed += 1;
    const top = tryGit(dir, "rev-parse --show-toplevel", creds)?.trim();
    if (top) return top;
    let entries: Dirent[];
    try {
      // Real directories only: linked trees (node_modules symlinks) are not
      // worth probing and would otherwise dominate the traversal.
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = join(dir, e.name);
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return undefined;
}

export interface ContractRepoCheck {
  ok: boolean;
  error?: string;
  /** Repository worktree root (only when ok). */
  repoDir?: string;
}

/**
 * Validate that every contract target resolves inside a git repository at call
 * time. Called before the child session exists so a bad contract fails and
 * notifies the agent instead of spawning a doomed session.
 *
 * Repositories are discovered *per target* — starting at the target's own
 * directory (upward) and then from the session base directory downward — so a
 * contract pointing at a nested scratch repo validates on its own merits
 * instead of demanding that the base directory itself be a repository.
 * Every target must land in the same repository: the contract is diffed as a
 * single unit against one baseline, so split targets are rejected rather than
 * silently judged from the wrong repo.
 *
 * When no target resolves, the error names the base directory and the
 * unwalked target so the failure is diagnosable.
 */
export function validateContractRepository(
  base: string,
  entries: ShoggothContractEntry[],
  creds?: ContractCreds,
): ContractRepoCheck {
  const targets = entries.map((entry) =>
    isAbsolute(entry.path) ? entry.path : resolve(base, entry.path),
  );

  let repoDir: string | undefined;
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]!;
    const start = existsSync(target) && statSync(target).isDirectory() ? target : dirname(target);
    const top = findRepoTopLevel(start, base, creds);
    if (!top) {
      return {
        ok: false,
        error: `contract target is not in a git repository: ${entries[i]!.path} (resolved against ${base})`,
      };
    }
    if (repoDir === undefined) {
      repoDir = top;
    } else if (top !== repoDir) {
      return {
        ok: false,
        error: `contract targets span multiple git repositories: ${entries[i]!.path} is in ${top}, not ${repoDir}`,
      };
    }
    const rel = relative(repoDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return {
        ok: false,
        error: `contract target escapes the git repository: ${entries[i]!.path}`,
      };
    }
  }
  return { ok: true, repoDir };
}
/** Resolve the diff baseline: the source branch HEAD when available, else spawn HEAD. */
export function resolveContractBaseline(
  repoDir: string,
  sourceBranch?: string,
  creds?: ContractCreds,
): string {
  if (sourceBranch) {
    const ref = tryGit(repoDir, `rev-parse --verify ${sourceBranch}^{commit}`, creds);
    if (ref?.trim()) return sourceBranch;
    log.warn("contract_baseline_branch_missing", { sourceBranch });
  }
  const head = tryGit(repoDir, "rev-parse HEAD", creds);
  if (head?.trim()) return head.trim();
  throw new Error("contract baseline unavailable: repository has no HEAD");
}

function inBaseline(repoDir: string, ref: string, relPath: string, creds?: ContractCreds): boolean {
  try {
    git(repoDir, ["cat-file", "-e", `${ref}:${relPath}`], creds);
    return true;
  } catch {
    return false;
  }
}

/** `git diff <ref> -- <path>` (ref vs working tree). Empty string when unchanged. */
function diffAgainstBaseline(
  repoDir: string,
  ref: string,
  relPath: string,
  creds?: ContractCreds,
): string {
  try {
    return git(repoDir, ["diff", ref, "--", relPath], creds);
  } catch {
    return "";
  }
}

/** Diff of an untracked/new file against /dev/null (create entries). */
function diffNewFile(absPath: string, repoDir: string, creds?: ContractCreds): string {
  try {
    runGit(["diff", "--no-index", "--", "/dev/null", absPath], repoDir, creds);
    return "";
  } catch (e) {
    // --no-index exits 1 when files differ; the diff is on stdout.
    const stdout = (e as { stdout?: string }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/**
 * Whether a contract target is present in the working tree.
 *
 * The fast path is a direct stat, but the daemon process may not be able to
 * read an agent-owned workspace (different UID), in which case `existsSync`
 * reports "missing" for files that are really there. When the direct stat
 * fails, the presence check is redone through git running as the contract
 * credentials, so permission-denied never looks like an absent file.
 */
function targetExists(
  abs: string,
  repoDir: string,
  relPath: string,
  creds?: ContractCreds,
): boolean {
  if (existsSync(abs)) return true;
  try {
    if (git(repoDir, ["ls-files", "--others", "--", relPath], creds).trim()) return true;
    const tracked = git(repoDir, ["ls-files", "--", relPath], creds).trim();
    if (!tracked) return false;
    const deleted = git(repoDir, ["ls-files", "--deleted", "--", relPath], creds).trim();
    if (!deleted) return true;
    // Some entries of a directory target may still be present.
    return deleted.split("\n").length < tracked.split("\n").length;
  } catch {
    return false;
  }
}

/**
 * Capture the repository HEAD as a spawn-time contract baseline. Throws when
 * the repository has no HEAD. Git env vars exported by hooks/CI are stripped.
 */
export function captureGitHead(repoDir: string, creds?: ContractCreds): string {
  const head = tryGit(repoDir, "rev-parse HEAD", creds);
  if (!head?.trim()) throw new Error("contract repository has no HEAD to diff against");
  return head.trim();
}

export interface ContractJudgedFile {
  path: string;
  action: "create" | "update" | "delete";
  yes: number;
  fulfilled: boolean;
}

/** Phase that decided a non-fulfilled contract — exactly one can be true. */
export type ContractBreakPhase = "file_ops" | "judge" | "error";

export interface ContractStatus {
  /**
   * Single verdict. `file_ops`: a target was not acted upon with its
   * contractual type (the judge never runs). `judge`: the decision model
   * rejected the diffs. `error`: verification infrastructure failed.
   * `reason` carries the phase detail and is absent when fulfilled.
   */
  status: "fulfilled" | ContractBreakPhase;
  reason?: string;
  /** Verification failure message (status `error` only). */
  error?: string;
  /** Decision model ref used for judging (undefined → default decision model). */
  model?: string;
  yesMinimum: number;
  entries: ShoggothContractEntry[];
  judged: ContractJudgedFile[];
  /** Paths that failed the structural (modification type) check. */
  violated: string[];
  /** Deleted targets — structural pass only; never sent to the decision model. */
  deletedSkipped: string[];
  /** Baseline the diffs were taken against. */
  baseline: string;
}

export interface VerifyContractInput {
  /** Child session working directory (contract paths resolve against it). */
  cwd: string;
  entries: ShoggothContractEntry[];
  /** Source branch for the baseline; omitted → spawn HEAD. */
  sourceBranch?: string;
  /** Credentials for git invocations; defaults to the agent UID/GID. */
  creds?: ContractCreds;
  config: ShoggothConfig;
  /** Per-spawn judge model (`provider-id/model-name`); wins over agents.contract.model. */
  judgeModel?: string;
  /** Decision evaluator override (tests / daemon plumbing). */
  /** Judge answers keyed by question id; an `error` string marks a decision failure. */
  runDecision?: (req: {
    state: unknown;
    questions: Record<string, unknown>;
    model?: string;
  }) => Promise<Record<string, unknown>>;
}

function emptyStatus(
  entries: ShoggothContractEntry[],
  yesMinimum: number,
  partial: Partial<ContractStatus> = {},
): ContractStatus {
  return {
    status: "error",
    yesMinimum,
    entries,
    judged: [],
    violated: [],
    deletedSkipped: [],
    baseline: "",
    ...partial,
  };
}

/**
 * Verify a contract after the subagent turn: structural modification-type
 * check first, then batched decision-model judging of the per-file diffs.
 */
export async function verifyContract(input: VerifyContractInput): Promise<ContractStatus> {
  const { cwd, entries, config } = input;
  const contractCfg = config.agents?.contract;
  const yesMinimum = contractCfg?.yesMinimum ?? CONTRACT_YES_MINIMUM_DEFAULT;
  const batchSize = contractCfg?.batchSize ?? CONTRACT_BATCH_SIZE_DEFAULT;
  const model = input.judgeModel ?? contractCfg?.model;

  const creds = input.creds;
  const repo = validateContractRepository(cwd, entries, creds);
  if (!repo.ok || !repo.repoDir) {
    return emptyStatus(entries, yesMinimum, { status: "error", error: repo.error });
  }
  const repoDir = repo.repoDir;

  let baseline: string;
  try {
    baseline = resolveContractBaseline(repoDir, input.sourceBranch, creds);
  } catch (e) {
    return emptyStatus(entries, yesMinimum, {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Structural check: was each target acted upon with its contractual type?
  const violated: string[] = [];
  const deletedSkipped: string[] = [];
  const toJudge: ShoggothContractEntry[] = [];
  const diffs = new Map<string, string>();

  for (const entry of entries) {
    const abs = isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path);
    const relPath = relative(repoDir, abs);
    const inBase = inBaseline(repoDir, baseline, relPath, creds);
    const exists = targetExists(abs, repoDir, relPath, creds);

    if (entry.action === "create") {
      if (inBase) {
        violated.push(entry.path);
      } else if (!exists) {
        violated.push(entry.path);
      } else {
        diffs.set(entry.path, diffNewFile(abs, repoDir, creds));
        toJudge.push(entry);
      }
    } else if (entry.action === "update") {
      if (!inBase || !exists) {
        violated.push(entry.path);
      } else {
        const diff = diffAgainstBaseline(repoDir, baseline, relPath, creds);
        if (!diff) {
          violated.push(entry.path);
        } else {
          diffs.set(entry.path, diff);
          toJudge.push(entry);
        }
      }
    } else {
      // delete
      if (!inBase || exists) {
        violated.push(entry.path);
      } else {
        deletedSkipped.push(entry.path);
      }
    }
  }

  if (violated.length > 0) {
    const reason = `not acted upon with the contractual type: ${violated.join(", ")}`;
    log.warn("contract_broken", { phase: "file_ops", violated, baseline });
    return emptyStatus(entries, yesMinimum, {
      status: "file_ops",
      reason,
      baseline,
      violated,
      deletedSkipped,
    });
  }

  const runDecision =
    input.runDecision ??
    (async (req) => {
      const svc = DecisionService.fromConfig(config.decision ?? { providers: {} });
      const res = await svc.evaluate({
        ...(req.model ? { model: req.model } : {}),
        state: req.state,
        questions: req.questions,
        timeout_ms: CONTRACT_JUDGE_TIMEOUT_MS,
      });
      if (res.status !== "complete") return { error: res.error };
      return res.answers;
    });

  const judged: ContractJudgedFile[] = [];
  for (let i = 0; i < toJudge.length; i += batchSize) {
    const batch = toJudge.slice(i, i + batchSize);
    const questions: Record<string, unknown> = {};
    batch.forEach((entry, j) => {
      questions[`contract_${i + j}`] = {
        type: "noul",
        instructions: `Does the diff below fulfill the contract entry for ${entry.path}?`,
        criteria: {
          true: `The contract is fulfilled: ${entry.summary}`,
          false: `The contract is not fulfilled: ${entry.summary}`,
        },
      };
    });
    const state = {
      baseline_ref: baseline,
      files: batch.map((entry) => ({
        path: entry.path,
        action: entry.action,
        summary: entry.summary,
        diff: diffs.get(entry.path) ?? "",
      })),
    };

    let answers: Record<string, unknown>;
    try {
      answers = await runDecision({ state, questions, ...(model ? { model } : {}) });
    } catch (e) {
      answers = { error: e instanceof Error ? e.message : String(e) };
    }
    if (typeof answers.error === "string") {
      const error = `contract decision failed: ${answers.error}`;
      log.warn("contract_judge_failed", { error, baseline });
      return emptyStatus(entries, yesMinimum, {
        status: "error",
        error,
        reason: error,
        baseline,
        deletedSkipped,
        judged,
      });
    }
    batch.forEach((entry, j) => {
      const answer = answers[`contract_${i + j}`] as { noul?: number } | undefined;
      const yes = typeof answer?.noul === "number" ? answer.noul : 0;
      judged.push({
        path: entry.path,
        action: entry.action,
        yes,
        fulfilled: yes >= yesMinimum,
      });
    });
  }

  const rejected = judged.filter((j) => !j.fulfilled).map((j) => j.path);
  const fulfilled = rejected.length === 0;
  log.info("contract_judged", {
    baseline,
    judged: judged.length,
    deletedSkipped: deletedSkipped.length,
    fulfilled,
    ...(rejected.length > 0 ? { rejected } : {}),
  });
  return {
    status: fulfilled ? "fulfilled" : "judge",
    // Absent when fulfilled — no reason for a contract that held.
    ...(fulfilled ? {} : { reason: `rejected by the judge: ${rejected.join(", ")}` }),
    ...(model ? { model } : {}),
    yesMinimum,
    entries,
    judged,
    violated,
    deletedSkipped,
    baseline,
  };
}
