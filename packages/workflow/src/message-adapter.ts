/**
 * Platform-agnostic interface for posting and editing messages.
 */
export interface MessageAdapter {
  postMessage(content: string): Promise<{ messageId: string }>;
  /** Returns false if editing is not supported or fails. */
  editMessage(messageId: string, content: string): Promise<boolean>;
  /**
   * Pin a posted message.
   *
   * Optional capability — platforms that support message pinning implement it;
   * platforms without pinning omit it and callers treat it as a no-op.
   */
  pinMessage?(messageId: string): Promise<void>;
}
