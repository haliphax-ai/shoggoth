import type {
  DiscordCreateMessageBody,
  DiscordEditMessageBody,
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
  /** Extra delay spread (ms) after Discord’s suggested wait. */
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

type DiscordRestOperation = "createMessage" | "editMessage" | "openDmChannel";

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
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
  };
}
