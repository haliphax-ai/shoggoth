import type { MessagePoster } from "./orchestrator.js";
import { getLogger } from "@shoggoth/shared";

const log = getLogger("workflow:message-poster");

/**
 * Discord-based MessagePoster implementation.
 * Posts messages to Discord channels via the messaging surface.
 */
export class DiscordMessagePoster implements MessagePoster {
  constructor(private messagingFn: (target: string, message: string) => Promise<void>) {}

  async post(sessionId: string, message: string): Promise<void> {
    try {
      log.debug("posting message", { target: sessionId, messageLength: message.length });
      await this.messagingFn(sessionId, message);
      log.debug("message posted successfully", { target: sessionId });
    } catch (err) {
      log.error("failed to post message", { target: sessionId, error: String(err) });
      throw err;
    }
  }
}
