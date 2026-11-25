/**
 * OOB (out-of-band) turn banner surface: post a "processing" banner as an
 * editable message via the session's streaming outbound, then edit it in place
 * with the terminal banner, extracted from platform.ts behind an explicit deps
 * parameter (no platform-closure capture).
 */

import type { OobTurnBannerHandle } from "@shoggoth/daemon/lib";
import type { DiscordMessagingRuntime } from "./bridge";
import type { Logger } from "./daemon-types";

/** Wiring for the OOB banner surface: the session's streaming outbound
 *  resolver and logging. */
export interface OobTurnBannerDeps {
  readonly logger: Logger;
  readonly streamingForSession: DiscordMessagingRuntime["streamingForSession"];
}

/**
 * Build the OOB turn banner surface. `begin` posts a "processing"
 * banner as an editable message via the session's streaming outbound. That
 * returns `undefined` when the session isn't surface-bound or the platform
 * can't edit messages, in which case callers fall back to plain delivery.
 * `finish` edits the banner message in place with the terminal banner plus
 * optional `to_operator` content and the turn's terminal status-bar line,
 * clearing the live bar first so it isn't rendered twice.
 */
export function createOobTurnBanner(deps: OobTurnBannerDeps) {
  return {
    async begin(input: {
      readonly sessionId: string;
      readonly processing: string;
    }): Promise<OobTurnBannerHandle | undefined> {
      const streamingOutbound = deps.streamingForSession(input.sessionId);
      if (!streamingOutbound) return undefined;
      try {
        const handle = await streamingOutbound.start();
        await handle.setFullContent(input.processing);
        return {
          sessionId: input.sessionId,
          setBody: async (text: string) => {
            await handle.setFullContent(text);
          },
          setStatusBar: async (line: string | null) => {
            if (handle.setStatusBar) await handle.setStatusBar(line);
          },
        };
      } catch (e) {
        deps.logger.warn("discord.oob_banner.begin_failed", {
          sessionId: input.sessionId,
          err: String(e),
        });
        return undefined;
      }
    },
    async finish(input: {
      readonly handle: OobTurnBannerHandle;
      readonly terminal: string;
      readonly content?: string;
      /** Terminal bar line (✅/🛑/❌) rendered by the turn's status-bar
       *  tracker; appended last so the banner matches every other turn
       *  surface. Omitted when the turn had no tracker. */
      readonly statusBar?: string;
    }): Promise<void> {
      // Clear the live bar (a state-only operation that makes no edit) so the
      // terminal body edit below lands the bar exactly once, mirroring the
      // messaging_surface delivery pattern.
      try {
        await input.handle.setStatusBar(null);
      } catch (e) {
        deps.logger.warn("discord.oob_banner.status_bar_clear_failed", {
          sessionId: input.handle.sessionId,
          err: String(e),
        });
      }
      // Edit the banner message in place via the handle captured at `begin`.
      // A missing `setBody` means the platform cannot edit messages, so there
      // is nothing to append to and we leave the processing banner as-is.
      if (!input.handle.setBody) return;
      try {
        // Compose terminal (+ optional content) then the terminal bar line
        // LAST — the same append order the messaging_surface delivery uses.
        const base = input.content ? `${input.terminal}\n\n${input.content}` : input.terminal;
        const body = input.statusBar ? `${base}\n\n${input.statusBar}` : base;
        await input.handle.setBody(body);
      } catch (e) {
        deps.logger.warn("discord.oob_banner.finish_failed", {
          sessionId: input.handle.sessionId,
          err: String(e),
        });
      }
    },
  };
}
