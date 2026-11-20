import { runAsUser } from "@shoggoth/os-exec";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { WORKSPACE_TEMPLATE_FILES } from "../sessions/session-system-prompt";

/**
 * Directory of default `AGENTS.md` / `IDENTITY.md` / … copies (image: `/app/templates/agent-workspace`).
 * Override for custom packs: `SHOGGOTH_AGENT_TEMPLATE_DIR`.
 */
export function resolveAgentTemplateDir(): string {
  const e = process.env.SHOGGOTH_AGENT_TEMPLATE_DIR?.trim();
  if (e) return e;
  return join(process.cwd(), "templates", "agent-workspace");
}

/**
 * Canonical workspace subdirectories. `prompts/` is the workspace-local prompt
 * directory (`control/prompt-ops.ts`); XDG dirs back `xdgEnvForWorkspace` so
 * tools like `uv` get writable paths. Remaining XDG dirs are created lazily by
 * those tools and inherit the default ACLs from the workspace root.
 */
const WORKSPACE_DIRS = [
  "skills",
  "memory",
  "tmp",
  "prompts",
  "media/inbound",
  ".config",
  ".local/share",
  ".local/state",
  ".cache",
] as const;

/**
 * Node does not expose xattr syscalls, so default ACLs are installed with
 * `setfacl` (the `acl` package; present in the runtime image).
 *
 * One `setfacl` invocation applies both the access ACL (so the daemon can read
 * a freshly bootstrapped workspace) and the default ACL (so every file and
 * subdirectory created beneath inherits daemon access — no recursive walk now
 * or ever). The bootstrap runs as the agent user, the owner of these dirs, so
 * it may set ACLs on them without root or `CAP_FOWNER`. Failures are non-fatal:
 * the workspace is still fully usable by the agent; only the daemon's ACL
 * bridge is missing (it surfaces later as `EACCES` for the daemon uid).
 */
function setDefaultAcls(dirs: readonly string[]): void {
  if (process.platform !== "linux") return;
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const base = [`u:${uid}:rwX`];
  for (const dir of dirs) {
    try {
      execFileSync("setfacl", ["-m", ...base, "-d", "-m", ...base, dir], {
        stdio: "ignore",
      });
    } catch {
      // setfacl unavailable or ACLs unsupported on the filesystem
    }
  }
}

/**
 * Access ACL only (no default) for individual files copied into the workspace
 * before the directory default ACLs existed — the daemon reads workspace
 * template files directly when assembling system prompts.
 */
function setFileAccessAcls(files: readonly string[]): void {
  if (process.platform !== "linux") return;
  const uid = process.getuid?.();
  if (uid === undefined) return;
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      execFileSync("setfacl", ["-m", `u:${uid}:rwX`, file], { stdio: "ignore" });
    } catch {
      // setfacl unavailable or ACLs unsupported on the filesystem
    }
  }
}

/**
 * Ensures the canonical workspace directories exist and copies any missing
 * template markdown files from the template directory (never overwrites
 * existing workspace files).
 */
export async function ensureAgentWorkspaceLayout(
  workspaceRoot: string,
  creds: { uid: number; gid: number },
  opts?: { readonly templateDir?: string },
): Promise<void> {
  const root = workspaceRoot.trim();
  if (!root) return;

  const srcDir = opts?.templateDir ?? resolveAgentTemplateDir();
  const templateFiles = WORKSPACE_TEMPLATE_FILES.filter((f) => f !== "BOOTSTRAP.md");

  const script = [
    'const fs = require("fs");',
    'const path = require("path");',
    "const root = process.env._WS_ROOT;",
    "const srcDir = process.env._TEMPLATE_DIR;",
    "const files = JSON.parse(process.env._TEMPLATE_FILES);",
    "const dirs = JSON.parse(process.env._WS_DIRS);",
    "const dmode = 0o770;",
    "const fmode = 0o660;",
    "fs.mkdirSync(root, { recursive: true, mode: dmode });",
    "for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true, mode: dmode });",
    "if (fs.existsSync(srcDir)) {",
    "  for (const name of files) {",
    "    const from = path.join(srcDir, name);",
    "    const to = path.join(root, name);",
    "    if (!fs.existsSync(from) || fs.existsSync(to)) continue;",
    "    fs.copyFileSync(from, to);",
    "    try { fs.chmodSync(to, fmode); } catch {}",
    "  }",
    "}",
  ].join("\n");

  const r = await runAsUser({
    file: process.execPath,
    args: ["-e", script],
    cwd: "/tmp",
    uid: creds.uid,
    gid: creds.gid,
    env: {
      _WS_ROOT: root,
      _TEMPLATE_DIR: srcDir,
      _TEMPLATE_FILES: JSON.stringify(templateFiles),
      _WS_DIRS: JSON.stringify(WORKSPACE_DIRS),
    },
  });

  if (r.exitCode !== 0) {
    throw new Error(r.stderr.trim() || `workspace layout setup failed (exit ${r.exitCode})`);
  }
  // Default ACLs for the daemon uid: on the root itself and on every directory
  // it created (the root's own default ACL propagates to pre-existing
  // subdirectories, but not the other way around), plus access ACLs for any
  // template files copied above.
  setDefaultAcls([root, ...WORKSPACE_DIRS.map((d) => join(root, d))]);
  setFileAccessAcls(WORKSPACE_TEMPLATE_FILES.map((f) => join(root, f)));
}
