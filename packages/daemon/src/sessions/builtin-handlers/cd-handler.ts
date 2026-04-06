import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";
import type { BuiltinToolRegistry, BuiltinToolContext, BuiltinToolResult } from "../builtin-tool-registry";
import { createSessionStore } from "../session-store";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("cd", cdHandler);
}

async function cdHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const pathArg = String(args.path ?? "").trim();

  // Empty/missing path → reset to workspace root
  if (!pathArg) {
    const store = createSessionStore(ctx.db);
    store.update(ctx.sessionId, { workingDirectory: null });
    return { resultJson: JSON.stringify({ workingDirectory: ctx.workspacePath }) };
  }

  const rootReal = realpathSync(ctx.workspacePath);
  const base = ctx.workingDirectory ?? rootReal;

  // Resolve: absolute paths as-is, relative from current working directory
  const resolved = isAbsolute(pathArg) ? pathArg : resolve(base, pathArg);

  // Security: must stay within workspace
  const rel = relative(rootReal, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  // Validate: must exist and be a directory
  let realTarget: string;
  try {
    realTarget = realpathSync(resolved);
  } catch {
    return { resultJson: JSON.stringify({ error: `path does not exist: ${pathArg}` }) };
  }

  // Security: realpath must also be within workspace
  const relReal = relative(rootReal, realTarget);
  if (relReal === ".." || relReal.startsWith(`..${sep}`)) {
    return { resultJson: JSON.stringify({ error: "path escapes workspace" }) };
  }

  try {
    const st = statSync(realTarget);
    if (!st.isDirectory()) {
      return { resultJson: JSON.stringify({ error: "not a directory" }) };
    }
  } catch {
    return { resultJson: JSON.stringify({ error: `cannot stat: ${pathArg}` }) };
  }

  // Persist
  const store = createSessionStore(ctx.db);
  store.update(ctx.sessionId, { workingDirectory: realTarget });

  return { resultJson: JSON.stringify({ workingDirectory: realTarget }) };
}
