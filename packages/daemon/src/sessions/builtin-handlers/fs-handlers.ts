// ---------------------------------------------------------------------------
// read & write handlers
// ---------------------------------------------------------------------------

import { toolRead, toolWrite } from "@shoggoth/os-exec";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("read", readHandler);
  registry.register("write", writeHandler);
}

async function readHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const path = String(args.path ?? "");
  const body = await toolRead(ctx.workspacePath, path, ctx.creds);
  return { resultJson: JSON.stringify({ path, content: body }) };
}

async function writeHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  await toolWrite(ctx.workspacePath, { path, content, mkdirp: true }, ctx.creds);
  return { resultJson: JSON.stringify({ ok: true, path }) };
}
