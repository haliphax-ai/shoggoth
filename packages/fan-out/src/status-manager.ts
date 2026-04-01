import type { TaskList } from "./types.js";
import type { MessageAdapter } from "./message-adapter.js";
import { formatStatusMessage, formatSummaryMessage } from "./status-message.js";

/**
 * Manages the lifecycle of status messages for a workflow.
 *
 * Tracks the posted message ID so subsequent updates can edit in-place.
 * Falls back to reposting if the platform doesn't support edits.
 */
export class StatusManager {
  private readonly adapter: MessageAdapter;
  private messageId: string | null = null;
  private repostMode = false;

  constructor(adapter: MessageAdapter) {
    this.adapter = adapter;
  }

  /** Format and post the initial status message. */
  async postInitialStatus(wf: TaskList): Promise<void> {
    const content = formatStatusMessage(wf);
    const result = await this.adapter.postMessage(content);
    this.messageId = result.messageId;
  }

  /** Format current status and edit the existing message (or repost on failure). */
  async updateStatus(wf: TaskList): Promise<void> {
    if (!this.messageId) return;

    const content = formatStatusMessage(wf);

    if (this.repostMode) {
      const result = await this.adapter.postMessage(content);
      this.messageId = result.messageId;
      return;
    }

    const ok = await this.adapter.editMessage(this.messageId, content);
    if (!ok) {
      this.repostMode = true;
      const result = await this.adapter.postMessage(content);
      this.messageId = result.messageId;
    }
  }

  /** Format and post the summarization message on workflow completion. */
  async postSummary(wf: TaskList): Promise<void> {
    const content = formatSummaryMessage(wf);
    await this.adapter.postMessage(content);
  }

  /** Whether the manager has switched to repost mode. */
  isRepostMode(): boolean {
    return this.repostMode;
  }
}
