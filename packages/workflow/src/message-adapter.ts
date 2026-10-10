/**
 * Platform-agnostic interface for posting and editing messages.
 */

/** Why an edit failed. Callers use this to decide whether a repost is safe. */
export type EditMessageFailureReason =
  /** The target message no longer exists (e.g. Discord 404). Repost. */
  | "not_found"
  /** The platform has no edit capability at all. Repost. */
  | "unsupported"
  /**
   * Transient failure (rate limit, 5xx, network). The message likely still
   * exists — do NOT repost; retry the edit on the next tick instead.
   */
  | "transient";

/** Result of an edit attempt, typed so transient failures are legible. */
export type EditMessageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EditMessageFailureReason };

export interface MessageAdapter {
  postMessage(content: string): Promise<{ messageId: string }>;
  /**
   * Edit an existing message. Returns a typed result: only `not_found` and
   * `unsupported` justify falling back to a repost; `transient` failures
   * should be retried in place.
   */
  editMessage(messageId: string, content: string): Promise<EditMessageResult>;
  /**
   * Pin a posted message.
   *
   * Optional capability — platforms that support message pinning implement it;
   * platforms without pinning omit it and callers treat it as a no-op.
   */
  pinMessage?(messageId: string): Promise<void>;
}
