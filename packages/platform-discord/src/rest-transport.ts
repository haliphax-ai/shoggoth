import { createDiscordRestClient, discordRestRateLimitPolicy } from "./rest-client";
import type { DiscordRestClient, DiscordRestPriority } from "./rest-client";
import type {
  DiscordChannelMessagesQuery,
  DiscordEditMessageBody,
  DiscordRestTransport,
} from "./transport";

export interface DiscordRestTransportOptions {
  readonly botToken: string;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  readonly apiBase?: string;
}

// Re-exported for tests and observability (the retry budget now lives in the
// centralized client; the shape is unchanged).
export { discordRestRateLimitPolicy };

/**
 * Default priority lane per operation. User-facing sends and edits outrank
 * background probes so reads (message history, search, reactions) never starve
 * a send behind a saturated bucket. Workflow-status edits and streaming edits
 * share the user lane — both are user-visible, and same-message contention is
 * handled by edit coalescing rather than lane ordering.
 */
const OPERATION_PRIORITY: Record<string, DiscordRestPriority> = {
  createMessage: "user",
  createMessageWithFiles: "user",
  editMessage: "user",
  deleteMessage: "user",
  pinMessage: "user",
  createThreadFromMessage: "user",
  createThread: "user",
  deleteChannel: "user",
  openDmChannel: "user",
  createMessageReaction: "user",
  deleteMessageReaction: "user",
  interactionCallback: "user",
  editOriginalInteractionResponse: "user",
  getMessage: "background",
  getChannelMessages: "background",
  getMessageReactions: "background",
  searchMessages: "background",
  triggerTypingIndicator: "background",
  registerGlobalCommands: "background",
};

/**
 * Discord REST v10 transport. Uses Bot token; suitable for daemon wiring and
 * CI mocks via `fetchFn`.
 *
 * All requests flow through a single rate-limit-aware client (see
 * `rest-client.ts`): proactive bucket metering from response headers,
 * per-bucket priority queues, latest-wins coalescing of same-message edits,
 * one backoff mechanism for 429/503 (whole-client pause on `global` limits),
 * and a typed error taxonomy instead of string-matched errors.
 *
 * Route keys follow Discord's major-parameter rules (channel/guild/webhook ids
 * kept; other dynamic segments normalized) so the `X-RateLimit-Bucket` hash
 * learned on one route meters every sibling route.
 */
export function createDiscordRestTransport(
  options: DiscordRestTransportOptions,
): DiscordRestTransport {
  const client: DiscordRestClient = createDiscordRestClient({
    botToken: options.botToken,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });

  function op(
    operation: keyof typeof OPERATION_PRIORITY | string,
    method: string,
    path: string,
    routeKey: string,
    body?: BodyInit,
    coalesceKey?: string,
  ): Promise<Response> {
    return client.request({
      operation,
      method,
      path,
      routeKey,
      ...(body !== undefined ? { body } : {}),
      ...(coalesceKey ? { coalesceKey } : {}),
    });
  }

  return {
    async openDmChannel(recipientUserId) {
      const res = await op(
        "openDmChannel",
        "POST",
        `/users/@me/channels`,
        `POST /users/@me/channels`,
        JSON.stringify({ recipient_id: recipientUserId }),
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST openDmChannel: missing id in response");
      return j.id;
    },

    async createMessage(channelId, body) {
      const res = await op(
        "createMessage",
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages`,
        `POST /channels/${channelId}/messages`,
        JSON.stringify(body),
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST createMessage: missing id in response");
      return { id: j.id };
    },

    async createMessageWithFiles(channelId, body, files) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(body));
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const blob = new Blob([f.data as BlobPart], { type: "application/octet-stream" });
        form.append(`files[${i}]`, blob, f.filename);
      }
      const res = await op(
        "createMessageWithFiles",
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages`,
        `POST /channels/${channelId}/messages`,
        form,
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST createMessageWithFiles: missing id in response");
      return { id: j.id };
    },

    async editMessage(channelId, messageId, body: DiscordEditMessageBody) {
      // Latest-wins coalescing: concurrent edits to the same message (streaming
      // updates vs. workflow status ticks) collapse to one in-flight request
      // plus the newest queued body; superseded edits settle with the survivor.
      await op(
        "editMessage",
        "PATCH",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        `PATCH /channels/${channelId}/messages/:id`,
        JSON.stringify(body),
        `edit:${channelId}:${messageId}`,
      );
    },

    async deleteMessage(channelId, messageId) {
      await op(
        "deleteMessage",
        "DELETE",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        `DELETE /channels/${channelId}/messages/:id`,
      );
    },

    async pinMessage(channelId, messageId) {
      await op(
        "pinMessage",
        "PUT",
        `/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
        `PUT /channels/${channelId}/pins/:id`,
      );
    },

    async createThreadFromMessage(channelId, messageId, threadBody) {
      const res = await op(
        "createThreadFromMessage",
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
        `POST /channels/${channelId}/messages/:id/threads`,
        JSON.stringify(threadBody),
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST createThreadFromMessage: missing id in response");
      return { id: j.id };
    },

    async createThread(channelId, threadBody) {
      const res = await op(
        "createThread",
        "POST",
        `/channels/${encodeURIComponent(channelId)}/threads`,
        `POST /channels/${channelId}/threads`,
        JSON.stringify(threadBody),
      );
      const j2 = (await res.json()) as { id?: string };
      if (!j2.id) throw new Error("Discord REST createThread: missing id in response");
      return { id: j2.id };
    },

    async deleteChannel(channelId) {
      await op(
        "deleteChannel",
        "DELETE",
        `/channels/${encodeURIComponent(channelId)}`,
        `DELETE /channels/${channelId}`,
      );
    },

    async getMessage(channelId, messageId) {
      const res = await op(
        "getMessage",
        "GET",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
        `GET /channels/${channelId}/messages/:id`,
      );
      const j = (await res.json()) as Record<string, unknown>;
      if (typeof j.id !== "string") {
        throw new Error("Discord REST getMessage: missing id in response");
      }
      return j;
    },

    async getChannelMessages(channelId, query: DiscordChannelMessagesQuery) {
      const params = new URLSearchParams();
      const lim =
        query.limit !== undefined ? Math.min(100, Math.max(1, Math.trunc(query.limit))) : undefined;
      if (lim !== undefined) params.set("limit", String(lim));
      const cursors = [query.before, query.after, query.around].filter(Boolean);
      if (cursors.length > 1) {
        throw new Error(
          "Discord REST getChannelMessages: set at most one of before, after, around",
        );
      }
      if (query.before) params.set("before", query.before);
      if (query.after) params.set("after", query.after);
      if (query.around) params.set("around", query.around);
      const q = params.toString();
      const res = await op(
        "getChannelMessages",
        "GET",
        `/channels/${encodeURIComponent(channelId)}/messages${q ? `?${q}` : ""}`,
        `GET /channels/${channelId}/messages`,
      );
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) {
        throw new Error("Discord REST getChannelMessages: expected JSON array");
      }
      return j as Record<string, unknown>[];
    },

    async createMessageReaction(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      await op(
        "createMessageReaction",
        "PUT",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}/@me`,
        `PUT /channels/${channelId}/messages/:id/reactions/:emoji/@me`,
      );
    },

    async deleteMessageReaction(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      await op(
        "deleteMessageReaction",
        "DELETE",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}/@me`,
        `DELETE /channels/${channelId}/messages/:id/reactions/:emoji/@me`,
      );
    },

    async getMessageReactions(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      const res = await op(
        "getMessageReactions",
        "GET",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}`,
        `GET /channels/${channelId}/messages/:id/reactions/:emoji`,
      );
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) {
        throw new Error("Discord REST getMessageReactions: expected JSON array");
      }
      return j as Record<string, unknown>[];
    },

    async searchMessages(guildId, query) {
      const params = new URLSearchParams();
      if (query.content) params.set("content", query.content);
      if (query.author_id) {
        const ids = Array.isArray(query.author_id) ? query.author_id : [query.author_id];
        for (const id of ids) params.append("author_id", id);
      }
      if (query.channel_id) {
        const ids = Array.isArray(query.channel_id) ? query.channel_id : [query.channel_id];
        for (const id of ids) params.append("channel_id", id);
      }
      if (query.min_id) params.set("min_id", query.min_id);
      if (query.max_id) params.set("max_id", query.max_id);
      if (query.limit !== undefined)
        params.set("limit", String(Math.min(25, Math.max(1, Math.trunc(query.limit)))));
      const q = params.toString();
      const res = await op(
        "searchMessages",
        "GET",
        `/guilds/${encodeURIComponent(guildId)}/messages/search${q ? `?${q}` : ""}`,
        `GET /guilds/${guildId}/messages/search`,
      );
      const j = (await res.json()) as {
        messages?: unknown[][];
        total_results?: number;
      };
      return {
        messages: (Array.isArray(j.messages) ? j.messages : []) as Record<string, unknown>[][],
        total_results: typeof j.total_results === "number" ? j.total_results : 0,
      };
    },

    async triggerTypingIndicator(channelId) {
      await op(
        "triggerTypingIndicator",
        "POST",
        `/channels/${encodeURIComponent(channelId)}/typing`,
        `POST /channels/${channelId}/typing`,
        JSON.stringify({}),
      );
    },

    async interactionCallback(interactionId, interactionToken, body) {
      await op(
        "interactionCallback",
        "POST",
        `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
        `POST /interactions/:id/:token/callback`,
        JSON.stringify(body),
      );
    },

    async registerGlobalCommands(applicationId, commands) {
      await op(
        "registerGlobalCommands",
        "PUT",
        `/applications/${encodeURIComponent(applicationId)}/commands`,
        `PUT /applications/:id/commands`,
        JSON.stringify(commands),
      );
    },

    async editOriginalInteractionResponse(applicationId, interactionToken, body) {
      // Coalesced like editMessage: repeated rewrites of the same deferred
      // response collapse to the newest body.
      await op(
        "editOriginalInteractionResponse",
        "PATCH",
        `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
        `PATCH /webhooks/:id/:token/messages/@original`,
        JSON.stringify(body),
        `edit-oir:${applicationId}:${interactionToken}`,
      );
    },
  };
}
