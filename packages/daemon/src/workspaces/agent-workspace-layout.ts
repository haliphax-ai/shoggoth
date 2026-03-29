import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_TEMPLATE_FILES } from "../sessions/session-system-prompt";

/**
 * Directory of default `AGENTS.md` / `SOUL.md` / … copies (image: `/app/templates/agent-workspace`).
 * Override for custom packs: `SHOGGOTH_AGENT_TEMPLATE_DIR`.
 */
export function resolveAgentTemplateDir(): string {
  const e = process.env.SHOGGOTH_AGENT_TEMPLATE_DIR?.trim();
  if (e) return e;
  return join(process.cwd(), "templates", "agent-workspace");
}

/**
 * Ensures `skills/` + `memory/` exist and copies any missing template markdown files from the
 * template directory (never overwrites existing workspace files).
 */
export function ensureAgentWorkspaceLayout(
  workspaceRoot: string,
  opts?: { readonly templateDir?: string },
): void {
  const root = workspaceRoot.trim();
  if (!root) return;

  const dmode = 0o770;
  mkdirSync(root, { recursive: true, mode: dmode });
  mkdirSync(join(root, "skills"), { recursive: true, mode: dmode });
  mkdirSync(join(root, "memory"), { recursive: true, mode: dmode });

  const srcDir = opts?.templateDir ?? resolveAgentTemplateDir();
  if (!existsSync(srcDir)) {
    return;
  }

  for (const name of WORKSPACE_TEMPLATE_FILES) {
    const from = join(srcDir, name);
    const to = join(root, name);
    if (!existsSync(from) || existsSync(to)) continue;
    copyFileSync(from, to);
    try {
      chmodSync(to, 0o660);
    } catch {
      /* non-root / exotic FS: kernel DAC may still allow agent via setgid dirs */
    }
  }
}
