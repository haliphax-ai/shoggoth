import { createDiscordRestClient } from "./rest-client";

/**
 * Discord REST: current bot user (`GET /users/@me`).
 *
 * Routed through the shared metered REST client (retry/backoff + logging).
 * Construction is side-effect-free, so this cannot deadlock startup.
 */
export async function fetchDiscordBotUserId(options: {
  readonly botToken: string;
  readonly fetchFn?: typeof fetch;
  readonly apiBase?: string;
}): Promise<string> {
  const rest = createDiscordRestClient({
    botToken: options.botToken,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
  });
  const res = await rest.request({
    operation: "getBotUser",
    method: "GET",
    path: "/users/@me",
    routeKey: "GET /users/@me",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Discord REST users/@me ${res.status}: ${text}`);
  }
  let j: unknown;
  try {
    j = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Discord REST users/@me: invalid JSON");
  }
  const o = j as { id?: unknown };
  if (typeof o.id !== "string" || !o.id.trim()) {
    throw new Error("Discord REST users/@me: missing id");
  }
  return o.id;
}
