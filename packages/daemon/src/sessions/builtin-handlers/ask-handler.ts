// ---------------------------------------------------------------------------
// ask handler
// ---------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("ask", ask);
}

async function ask(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const mtCtx = ctx.messageToolCtx;
  if (!mtCtx) {
    return {
      resultJson: JSON.stringify({ error: "ask_tool_unavailable" }),
    };
  }
  // The ask tool is the dedicated surface for reaction-based choice prompts.
  // The choice engine lives on the messaging tool executor.
  const result = await mtCtx.execute(ctx.sessionId, { ...args, action: "choice" });
  return { resultJson: JSON.stringify(result) };
}
