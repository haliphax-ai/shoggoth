/**
 * Routes operator-initiated MCP streamable HTTP `cancelRequest` to the live pool
 * for a Shoggoth session or the global MCP slice.
 */

/** Use this `session_id` with control / CLI when targeting the platform global MCP pool. */
export const SHOGGOTH_GLOBAL_MCP_SESSION_KEY = "__global__";

type CancelHandler = (sourceId: string, requestId: number) => boolean;

const handlers = new Map<string, CancelHandler>();

/**
 * Registers a pool's cancel handler for `sessionId` (or {@link SHOGGOTH_GLOBAL_MCP_SESSION_KEY}).
 * Call the returned function before or when the pool closes to avoid leaks.
 */
export function registerMcpHttpCancelHandler(sessionId: string, handler: CancelHandler): () => void {
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) {
      handlers.delete(sessionId);
    }
  };
}

/** Invokes the registered handler for `sessionId`, if any. */
export function dispatchMcpHttpCancelRequest(input: {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly requestId: number;
}): boolean {
  const h = handlers.get(input.sessionId);
  if (!h) return false;
  return h(input.sourceId, input.requestId);
}
