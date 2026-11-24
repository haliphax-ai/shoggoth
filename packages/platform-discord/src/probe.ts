import { createDiscordRestClient, NetworkError } from "./rest-client";
import type { DependencyProbe, DependencyCheck } from "./daemon-types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const PROBE_TIMEOUT_MS = 5000;

/**
 * Cap a probe request at `ms` so a hung fetch cannot stall health reporting
 * (the metered client has no per-request signal). The underlying request is
 * abandoned, not aborted; the client settles it on its own.
 */
function withTimeout(p: Promise<Response>, ms: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Discord health probe timed out after ${ms}ms`)), ms);
  });
  (timer as { unref?: () => void } | undefined)?.unref?.();
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Map the `GET /users/@me` response to a probe result. */
async function probeResultFrom(res: Response): Promise<DependencyCheck> {
  if (res.status === 200) {
    let detail = "ok";
    try {
      const text = await res.text();
      const j = JSON.parse(text) as { username?: string; id?: string };
      if (j.username && j.id) detail = `${j.username} (${j.id})`;
      else if (j.username) detail = j.username;
      else if (j.id) detail = `id ${j.id}`;
    } catch {
      /* ignore malformed body */
    }
    return { name: "discord", status: "pass", detail };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      name: "discord",
      status: "fail",
      detail: `invalid or unauthorized token (HTTP ${res.status})`,
    };
  }
  return { name: "discord", status: "fail", detail: `unexpected HTTP ${res.status}` };
}

/** Discord token reachability via `GET /users/@me`. */
export function createDiscordProbe(options: {
  getToken: () => string | undefined;
  /** Override the API base (tests); defaults to the Discord REST v10 root. */
  apiBase?: string;
}): DependencyProbe {
  return {
    name: "discord",
    async check(): Promise<DependencyCheck> {
      const t = options.getToken()?.trim();
      if (!t) {
        return { name: "discord", status: "skipped", detail: "not configured" };
      }
      try {
        // Metered client in the background lane; the timeout cap below keeps
        // the probe fail-fast regardless of the client's retry budget.
        const rest = createDiscordRestClient({
          botToken: t,
          apiBase: options.apiBase ?? DISCORD_API_BASE,
        });
        const res = await withTimeout(
          rest.request({
            operation: "healthProbe",
            method: "GET",
            path: "/users/@me",
            routeKey: "GET /users/@me",
            priority: "background",
          }),
          PROBE_TIMEOUT_MS,
        );
        return await probeResultFrom(res);
      } catch (e) {
        // Network failures unwrap to the bare cause (e.g. `ECONNRESET`); the
        // client's `discord.rest.*` log record carries the operation context.
        const msg =
          e instanceof NetworkError && e.cause instanceof Error
            ? e.cause.message
            : e instanceof Error
              ? e.message
              : String(e);
        return { name: "discord", status: "fail", detail: msg };
      }
    },
  };
}
