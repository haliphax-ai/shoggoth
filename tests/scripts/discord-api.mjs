/**
 * Host-side helpers for readiness tests (Discord REST). Uses DISCORD_BOT_TOKEN from env only.
 */

const API = "https://discord.com/api/v10";

export async function discordFetch(path, token, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      Connection: "close",
      ...init.headers,
    },
  });
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: r.ok, status: r.status, body };
}

/** Open or return existing DM channel with recipient (user id snowflake string). */
export async function ensureDmChannel(token, recipientUserId) {
  const r = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    body: JSON.stringify({ recipient_id: recipientUserId }),
  });
  const body = await r.json();
  if (!r.ok) {
    throw new Error(`DM channel: HTTP ${r.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

/**
 * Build SHOGGOTH_DISCORD_ROUTES JSON: guild readiness channel + optional DM to operator user.
 */
export async function buildDiscordRoutesJson(token, options) {
  const {
    guildId = "695327822306345040",
    /** Default: readiness channel <#1487579255616573533> (not #developer). */
    channelId = "1487579255616573533",
    guildSessionId = "readiness-guild",
    dmUserId = "347033761822801922",
    dmSessionId = "readiness-dm",
    includeDm = true,
  } = options;

  const routes = [
    { guildId, channelId, sessionId: guildSessionId },
  ];
  if (includeDm) {
    try {
      const dmChannelId = await ensureDmChannel(token, dmUserId);
      routes.push({ channelId: dmChannelId, sessionId: dmSessionId });
    } catch (e) {
      console.warn("readiness: DM route skipped:", (e && e.message) || e);
    }
  }
  return JSON.stringify(routes);
}

export async function getBotUserId(token) {
  const { ok, body } = await discordFetch("/users/@me", token);
  if (!ok || !body?.id) throw new Error(`users/@me failed: ${JSON.stringify(body)}`);
  return body.id;
}

export async function listChannelMessages(token, channelId, limit = 25) {
  const { ok, body, status } = await discordFetch(
    `/channels/${channelId}/messages?limit=${limit}`,
    token,
  );
  if (!ok) throw new Error(`messages list HTTP ${status}: ${JSON.stringify(body)}`);
  return Array.isArray(body) ? body : [];
}

/** Create a message in a guild or DM channel (bot token). */
export async function postChannelMessage(token, channelId, content) {
  const { ok, body, status } = await discordFetch(`/channels/${channelId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (!ok) throw new Error(`post message HTTP ${status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Poll until user `userId` posts `trigger` then bot `botId` posts a non-empty reply after it.
 *
 * @param {object} [options]
 * @param {string} [options.afterMessageId] If set, only messages with snowflake id **strictly greater**
 *   than this are considered (avoids matching stale history when reusing a short trigger like `blergh`).
 */
export async function waitForCooperativeRoundTrip(
  token,
  channelId,
  userId,
  botId,
  trigger,
  timeoutMs,
  options = {},
) {
  const minId = options.afterMessageId ? BigInt(options.afterMessageId) : null;
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    const msgs = await listChannelMessages(token, channelId, 50);
    const asc = [...msgs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const relevant = minId === null ? asc : asc.filter((m) => BigInt(m.id) > minId);
    let userIdx = -1;
    for (let i = 0; i < relevant.length; i++) {
      const m = relevant[i];
      if (m.author?.id === userId && typeof m.content === "string" && m.content.includes(trigger)) {
        userIdx = i;
        break;
      }
    }
    if (userIdx >= 0) {
      for (let j = userIdx + 1; j < relevant.length; j++) {
        const m = relevant[j];
        if (
          m.author?.id === botId &&
          typeof m.content === "string" &&
          m.content.trim().length > 0
        ) {
          return { userMessage: relevant[userIdx], botMessage: m };
        }
      }
    }
    const now = Date.now();
    if (now - lastBeat >= 30_000) {
      lastBeat = now;
      const secLeft = Math.max(0, Math.round((deadline - now) / 1000));
      const phase =
        userIdx >= 0
          ? "trigger seen; waiting for bot reply after your message"
          : "waiting for your message containing the trigger in this channel";
      console.log(`[cooperative E2E] ${phase} (${secLeft}s left)`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(
    `Timeout waiting for cooperative Discord round-trip (user ${userId} post "${trigger}" then bot reply)`,
  );
}
