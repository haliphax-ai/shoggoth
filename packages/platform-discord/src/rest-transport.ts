import type {
  DiscordChannelMessagesQuery,
  DiscordCreateMessageBody,
  DiscordEditMessageBody,
  DiscordMessageUploadFile,
  DiscordRestTransport,
} from "./transport";

export interface DiscordRestTransportOptions {
  readonly botToken: string;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  readonly apiBase?: string;
}

/** Exported for tests and observability. */
export const discordRestRateLimitPolicy = {
  maxAttempts: 6,
  maxTotalWaitMs: 90_000,
  /** Extra delay spread (ms) after Discord's suggested wait. */
  jitterMaxMs: 250,
  /** When Discord returns 429 but no `retry_after` / `Retry-After`, wait this many seconds before retrying. */
  default429DelaySec: 1,
} as const;

function parseRetryDelaySeconds(res: Response, bodyText: string): number | null {
  try {
    const j = JSON.parse(bodyText) as { retry_after?: unknown };
    if (typeof j.retry_after === "number" && Number.isFinite(j.retry_after)) {
      return Math.max(0, j.retry_after);
    }
  } catch {
    /* not JSON or unexpected shape */
  }
  const h = res.headers.get("Retry-After");
  if (h == null || h === "") return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DiscordRestOperation =
  | "createMessage"
  | "createMessageWithFiles"
  | "editMessage"
  | "deleteMessage"
  | "getMessage"
  | "getChannelMessages"
  | "createThreadFromMessage"
  | "deleteChannel"
  | "openDmChannel"
  | "createMessageReaction"
  | "triggerTypingIndicator";

async function discordFetchWithRateLimitRetry(
  doFetch: () => Promise<Response>,
  operation: DiscordRestOperation,
): Promise<Response> {
  const { maxAttempts, maxTotalWaitMs, jitterMaxMs, default429DelaySec } = discordRestRateLimitPolicy;
  let totalWaitedMs = 0;
  let attempt = 0;

  while (true) {
    attempt++;
    const res = await doFetch();
    if (res.ok) return res;

    const status = res.status;
    const bodyText = await res.text();
    const retryAfterHeaderPresent = res.headers.get("Retry-After") != null && res.headers.get("Retry-After") !== "";
    const shouldRetry =
      status === 429 || (status === 503 && retryAfterHeaderPresent);

    if (!shouldRetry || attempt >= maxAttempts) {
      throw new Error(`Discord REST ${operation} ${status}: ${bodyText}`);
    }

    let delaySec = parseRetryDelaySeconds(res, bodyText);
    if (delaySec === null && status === 429) delaySec = default429DelaySec;
    if (delaySec === null) {
      throw new Error(`Discord REST ${operation} ${status}: ${bodyText}`);
    }

    const jitter = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
    const waitMs = Math.ceil(delaySec * 1000) + jitter;
    if (totalWaitedMs + waitMs > maxTotalWaitMs) {
      throw new Error(
        `Discord REST ${operation} ${status}: rate limit retry budget exceeded (${totalWaitedMs}ms waited, next wait ${waitMs}ms)`,
      );
    }
    totalWaitedMs += waitMs;
    await sleep(waitMs);
  }
}

/**
 * Discord REST v10 transport. Uses Bot token; suitable for daemon wiring and CI mocks via `fetchFn`.
 * Retries on 429 and on 503 when a `Retry-After` header is present, respecting `retry_after` / `Retry-After` with capped attempts and total wait.
 */
export function createDiscordRestTransport(options: DiscordRestTransportOptions): DiscordRestTransport {
  const base = (options.apiBase ?? "https://discord.com/api/v10").replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const auth = `Bot ${options.botToken}`;

  async function discordFetch(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", auth);
    if (init.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetchFn(`${base}${path}`, { ...init, headers });
  }

  return {
    async openDmChannel(recipientUserId) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(`/users/@me/channels`, {
            method: "POST",
            body: JSON.stringify({ recipient_id: recipientUserId }),
          }),
        "openDmChannel",
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST openDmChannel: missing id in response");
      return j.id;
    },

    async createMessage(channelId, body) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
        "createMessage",
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
        const blob = new Blob([f.data], { type: "application/octet-stream" });
        form.append(`files[${i}]`, blob, f.filename);
      }
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
            method: "POST",
            body: form,
          }),
        "createMessageWithFiles",
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST createMessageWithFiles: missing id in response");
      return { id: j.id };
    },

    async editMessage(channelId, messageId, body: DiscordEditMessageBody) {
      await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
            {
              method: "PATCH",
              body: JSON.stringify(body),
            },
          ),
        "editMessage",
      );
    },

    async deleteMessage(channelId, messageId) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
            { method: "DELETE" },
          ),
        "deleteMessage",
      );
      if (!res.ok && res.status !== 204) {
        const bodyText = await res.text();
        throw new Error(`Discord REST deleteMessage ${res.status}: ${bodyText}`);
      }
    },

    async createThreadFromMessage(channelId, messageId, threadBody) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
            {
              method: "POST",
              body: JSON.stringify(threadBody),
            },
          ),
        "createThreadFromMessage",
      );
      const j = (await res.json()) as { id?: string };
      if (!j.id) throw new Error("Discord REST createThreadFromMessage: missing id in response");
      return { id: j.id };
    },

    async deleteChannel(channelId) {
      const res = await discordFetchWithRateLimitRetry(
        () => discordFetch(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" }),
        "deleteChannel",
      );
      if (!res.ok && res.status !== 204) {
        const bodyText = await res.text();
        throw new Error(`Discord REST deleteChannel ${res.status}: ${bodyText}`);
      }
    },

    async getMessage(channelId, messageId) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
            { method: "GET" },
          ),
        "getMessage",
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
        query.limit !== undefined
          ? Math.min(100, Math.max(1, Math.trunc(query.limit)))
          : undefined;
      if (lim !== undefined) params.set("limit", String(lim));
      const cursors = [query.before, query.after, query.around].filter(Boolean);
      if (cursors.length > 1) {
        throw new Error("Discord REST getChannelMessages: set at most one of before, after, around");
      }
      if (query.before) params.set("before", query.before);
      if (query.after) params.set("after", query.after);
      if (query.around) params.set("around", query.around);
      const q = params.toString();
      const path = `/channels/${encodeURIComponent(channelId)}/messages${q ? `?${q}` : ""}`;
      const res = await discordFetchWithRateLimitRetry(() => discordFetch(path, { method: "GET" }), "getChannelMessages");
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j)) {
        throw new Error("Discord REST getChannelMessages: expected JSON array");
      }
      return j as Record<string, unknown>[];
    },

    async createMessageReaction(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}/@me`,
            { method: "PUT" },
          ),
        "createMessageReaction",
      );
      if (!res.ok && res.status !== 204) {
        const bodyText = await res.text();
        throw new Error(`Discord REST createMessageReaction ${res.status}: ${bodyText}`);
      }
    },

    async deleteMessageReaction(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}/@me`,
            { method: "DELETE" },
          ),
        "createMessageReaction",
      );
      if (!res.ok && res.status !== 204) {
        const bodyText = await res.text();
        throw new Error(`Discord REST deleteMessageReaction ${res.status}: ${bodyText}`);
      }
    },

    async getMessageReactions(channelId, messageId, emoji) {
      const enc = encodeURIComponent(emoji);
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${enc}`,
            { method: "GET" },
          ),
        "getMessage",
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
      if (query.limit !== undefined) params.set("limit", String(Math.min(25, Math.max(1, Math.trunc(query.limit)))));
      const q = params.toString();
      const path = `/guilds/${encodeURIComponent(guildId)}/messages/search${q ? `?${q}` : ""}`;
      const res = await discordFetchWithRateLimitRetry(
        () => discordFetch(path, { method: "GET" }),
        "getMessage",
      );
      const j = (await res.json()) as { messages?: unknown[][]; total_results?: number };
      return {
        messages: (Array.isArray(j.messages) ? j.messages : []) as Record<string, unknown>[][],
        total_results: typeof j.total_results === "number" ? j.total_results : 0,
      };
    },

    async triggerTypingIndicator(channelId) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(`/channels/${encodeURIComponent(channelId)}/typing`, {
            method: "POST",
            body: JSON.stringify({}),
          }),
        "triggerTypingIndicator",
      );
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Discord REST triggerTypingIndicator ${res.status}: ${bodyText}`);
      }
    },

    async interactionCallback(interactionId, interactionToken, body) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
            {
              method: "POST",
              body: JSON.stringify(body),
            },
          ),
        "interactionCallback" as DiscordRestOperation,
      );
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Discord REST interactionCallback ${res.status}: ${bodyText}`);
      }
    },

    async registerGlobalCommands(applicationId, commands) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/applications/${encodeURIComponent(applicationId)}/commands`,
            {
              method: "PUT",
              body: JSON.stringify(commands),
            },
          ),
        "registerGlobalCommands" as DiscordRestOperation,
      );
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Discord REST registerGlobalCommands ${res.status}: ${bodyText}`);
      }
    },

    async editOriginalInteractionResponse(applicationId, interactionToken, body) {
      const res = await discordFetchWithRateLimitRetry(
        () =>
          discordFetch(
            `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
            {
              method: "PATCH",
              body: JSON.stringify(body),
            },
          ),
        "editOriginalInteractionResponse" as DiscordRestOperation,
      );
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Discord REST editOriginalInteractionResponse ${res.status}: ${bodyText}`);
      }
    },
  };
}
