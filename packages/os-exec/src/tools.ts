import { realpathSync } from "node:fs";
import { join } from "node:path";
import { runAsUser, type RunAsUserResult } from "./subprocess";
import { resolvePathForRead, resolvePathForWrite } from "./workspace-path";

export interface AgentCredentials {
  uid: number;
  gid: number;
}

const ENV_READ = "SHOGGOTH_TOOL_READ_PATH";
const ENV_WRITE = "SHOGGOTH_TOOL_WRITE_PATH";

function nodeReadScript(): string {
  return `require("fs").writeFileSync(1, require("fs").readFileSync(process.env.${ENV_READ}, "utf8"));`;
}

function nodeWriteScript(): string {
  return `require("fs").writeFileSync(process.env.${ENV_WRITE}, require("fs").readFileSync(0, "utf8"));`;
}

/**
 * Read a workspace-relative path as the agent UID/GID (kernel DAC applies to the child).
 */
export async function toolRead(
  workspaceRoot: string,
  userPath: string,
  creds: AgentCredentials,
): Promise<string> {
  const abs = resolvePathForRead(workspaceRoot, userPath);
  const cwd = realpathSync(workspaceRoot);
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeReadScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    env: { [ENV_READ]: abs },
  });
  if (r.exitCode !== 0) {
    throw new Error(`toolRead failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
  return r.stdout;
}

/**
 * Write content to a workspace-relative path as the agent UID/GID.
 */
export async function toolWrite(
  workspaceRoot: string,
  userPath: string,
  content: string,
  creds: AgentCredentials,
): Promise<void> {
  const abs = resolvePathForWrite(workspaceRoot, userPath);
  const cwd = realpathSync(workspaceRoot);
  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", nodeWriteScript()],
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    stdin: content,
    env: { [ENV_WRITE]: abs },
  });
  if (r.exitCode !== 0) {
    throw new Error(`toolWrite failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
}

/**
 * XDG base directories scoped to the agent workspace so tools like `uv` get writable
 * config/cache/data paths without touching daemon-owned trees.
 */
function xdgEnvForWorkspace(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    HOME: workspaceRoot,
    XDG_CONFIG_HOME: join(workspaceRoot, ".config"),
    XDG_DATA_HOME: join(workspaceRoot, ".local", "share"),
    XDG_CACHE_HOME: join(workspaceRoot, ".cache"),
    XDG_STATE_HOME: join(workspaceRoot, ".local", "state"),
  };
}

/**
 * Execute argv[0] with remaining args; working directory is the real workspace root.
 */
export async function toolExec(
  workspaceRoot: string,
  argv: string[],
  creds: AgentCredentials,
): Promise<RunAsUserResult> {
  if (argv.length === 0) {
    throw new Error("toolExec requires a non-empty argv");
  }
  const cwd = realpathSync(workspaceRoot);
  const file = argv[0]!;
  const args = argv.slice(1);
  return runAsUser({
    file,
    args,
    cwd,
    uid: creds.uid,
    gid: creds.gid,
    env: xdgEnvForWorkspace(cwd),
  });
}
