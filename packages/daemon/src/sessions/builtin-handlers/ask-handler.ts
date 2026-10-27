// ---------------------------------------------------------------------------
// ask handler
// ---------------------------------------------------------------------------

import { validateChoiceArgs } from "@shoggoth/messaging";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { enqueueAsk } from "./ask-defer";

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
  // Validate up front so a bad prompt fails inside this turn rather than
  // surfacing only when the deferred post runs at turn end.
  const validated = validateChoiceArgs(args);
  if (!validated.ok) {
    return { resultJson: JSON.stringify({ ok: false, error: validated.error }) };
  }
  // The ask tool is the dedicated surface for reaction-based choice prompts.
  // The choice engine lives on the messaging tool executor. During a live
  // turn the prompt is deferred to turn end (see ask-defer) so it never
  // lands mid-stream between split messages of long output.
  const result = await enqueueAsk(mtCtx, ctx.sessionId, args);
  return { resultJson: JSON.stringify(result) };
}
