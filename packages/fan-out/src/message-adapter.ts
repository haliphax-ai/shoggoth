/**
 * Platform-agnostic interface for posting and editing messages.
 */
export interface MessageAdapter {
  postMessage(content: string): Promise<{ messageId: string }>;
  /** Returns false if editing is not supported or fails. */
  editMessage(messageId: string, content: string): Promise<boolean>;
}
