import type { TaskList } from "./types.js";
import type { MessageAdapter } from "./message-adapter.js";
import { formatStatusMessage, formatSummaryMessage } from "./status-message.js";

export interface StatusManagerOptions {
  /**
   * Pin the status post when it is (re)created, when the platform supports pinning.
   * Default: true.
   */
  readonly pinStatusPost?: boolean;
}

/**
 * Manages the lifecycle of status messages for a workflow.
 *
 * Tracks the posted message ID so subsequent updates can edit in-place.
 * Falls back to reposting if the platform doesn't support edits.
 * Pins the status post whenever it is (re)created when the platform supports
 * pinning and `pinStatusPost` is enabled (default).
 */
export class StatusManager {
  private readonly adapter: MessageAdapter;
  private readonly pinStatusPost: boolean;
  private messageId: string | null = null;

  constructor(adapter: MessageAdapter, options: StatusManagerOptions = {}) {
    this.adapter = adapter;
    this.pinStatusPost = options.pinStatusPost ?? true;
  }

  /** Format and post the initial status message. */
  async postInitialStatus(wf: TaskList): Promise<void> {
    const content = formatStatusMessage(wf);
    const result = await this.adapter.postMessage(content);
    this.messageId = result.messageId;
    await this.pinIfSupported(result.messageId);
  }

  /** Format current status and edit the existing message (or repost on failure). */
  async updateStatus(wf: TaskList): Promise<void> {
    if (!this.messageId) return;

    const content = formatStatusMessage(wf);

    const ok = await this.adapter.editMessage(this.messageId, content);
    if (!ok) {
      const result = await this.adapter.postMessage(content);
      this.messageId = result.messageId;
      await this.pinIfSupported(result.messageId);
    }
  }

  /** Pin a freshly created status message when the adapter supports it and pinning is enabled. */
  private async pinIfSupported(messageId: string): Promise<void> {
    if (!this.pinStatusPost) return;
    if (!messageId) return;
    if (!this.adapter.pinMessage) return;
    try {
      await this.adapter.pinMessage(messageId);
    } catch {
      // Pinning is best-effort — never fail the status flow because a pin failed.
    }
  }

  /** Format and post the summarization message on workflow completion. */
  async postSummary(wf: TaskList): Promise<void> {
    const content = formatSummaryMessage(wf);
    await this.adapter.postMessage(content);
  }
}
