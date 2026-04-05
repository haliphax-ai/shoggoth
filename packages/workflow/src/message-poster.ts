/**
 * Platform-agnostic MessagePoster for workflow message tasks.
 * Posts messages to channels/sessions through a generic messaging function.
 */
export interface MessagePoster {
  post(target: string, message: string): Promise<void>;
}

/**
 * Generic MessagePoster implementation that delegates to a provided messaging function.
 * The messaging function handles platform-specific delivery (Discord, Slack, etc).
 */
export class GenericMessagePoster implements MessagePoster {
  constructor(private messagingFn: (target: string, message: string) => Promise<void>) {}

  async post(target: string, message: string): Promise<void> {
    await this.messagingFn(target, message);
  }
}
