import { parseAgentSessionUrn, resolvePlatformConfig, resolveAgentPlatformConfig, registerPlatformConfigValidator, type ShoggothConfig } from "@shoggoth/shared";
import { z } from "zod";
import { parseDiscordRoutesWithMeta, type DiscordSessionRoute } from "./bridge";

// ---------------------------------------------------------------------------
// Register Discord-specific extension validator
// ---------------------------------------------------------------------------

const discordExtensionSchema = z.object({
  token: z.string().optional(),
  ownerUserId: z.string().optional(),
  intents: z.number().optional(),
  allowBotMessages: z.boolean().optional(),
  hitlNotifyDmUserId: z.string().optional(),
  hitlNotifyChannelId: z.string().optional(),
  hitlNotifyWebhookUrl: z.string().optional(),
});

registerPlatformConfigValidator("discord", (raw) => {
  const result = discordExtensionSchema.safeParse(raw);
  if (result.success) return { valid: true };
  return { valid: false, errors: result.error.issues.map((i) => i.message) };
});

// ---------------------------------------------------------------------------
// Helpers — read from resolved platform config with backward compat
// ---------------------------------------------------------------------------

/** Resolve Discord platform config from `platforms.discord` or deprecated top-level `discord`. */
function resolveDiscordPlatformConfig(cfg: ShoggothConfig): Record<string, unknown> | undefined {
  return resolvePlatformConfig(cfg, "discord");
}

/** Env `SHOGGOTH_AGENT_ID` wins; else `runtime.agentId`; default `main`. */
export function resolveShoggothAgentId(cfg: ShoggothConfig): string {
  const e = process.env.SHOGGOTH_AGENT_ID?.trim();
  if (e) return e;
  return cfg.runtime?.agentId?.trim() || "main";
}


export function resolveEffectiveDiscordRoutes(cfg: ShoggothConfig): DiscordSessionRoute[] {
  const fromAgents: DiscordSessionRoute[] = [];
  for (const [aidRaw, agent] of Object.entries(cfg.agents?.list ?? {})) {
    const agentDiscord = resolveAgentPlatformConfig(agent, "discord");
    const rows = agentDiscord?.routes as Array<Record<string, unknown>> | undefined;
    if (!rows?.length) continue;
    const aid = aidRaw.trim();
    let parsed: DiscordSessionRoute[];
    try {
      parsed = parseDiscordRoutesWithMeta(JSON.stringify(rows)).routes;
    } catch {
      continue;
    }
    for (const r of parsed) {
      const p = parseAgentSessionUrn(r.sessionId);
      if (!p || p.agentId !== aid) continue;
      fromAgents.push(r);
    }
  }

  return fromAgents;
}

export function resolveDiscordIntents(cfg: ShoggothConfig): number | undefined {
  const raw = process.env.SHOGGOTH_DISCORD_INTENTS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  const dc = resolveDiscordPlatformConfig(cfg);
  return dc?.intents as number | undefined;
}

export function resolveDiscordAllowBotMessages(cfg: ShoggothConfig): boolean {
  const e = process.env.SHOGGOTH_DISCORD_ALLOW_BOT;
  if (e === "1") return true;
  if (e === "0") return false;
  const dc = resolveDiscordPlatformConfig(cfg);
  return dc?.allowBotMessages === true;
}

/** Env `SHOGGOTH_DISCORD_OWNER_USER_ID` wins; else layered `discord.ownerUserId`. */
export function resolveDiscordOwnerUserId(cfg: ShoggothConfig): string | undefined {
  const e = process.env.SHOGGOTH_DISCORD_OWNER_USER_ID?.trim();
  if (e) return e;
  const dc = resolveDiscordPlatformConfig(cfg);
  return (dc?.ownerUserId as string | undefined)?.trim() || undefined;
}

/**
 * Merges `discord` / `runtime` flags into env for code paths that still read `SHOGGOTH_*`.
 * **Precedence:** `override` (e.g. tests) > `process.env` > config-derived defaults.
 */
export function mergeOrchestratorEnv(cfg: ShoggothConfig, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...override };
  const d = resolveDiscordPlatformConfig(cfg);
  const r = cfg.runtime;
  const setIfEmpty = (key: string, val: string | undefined) => {
    if (val === undefined || val === "") return;
    const cur = base[key];
    if (cur === undefined || cur === "") base[key] = val;
  };
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_CHANNEL_ID", d?.hitlNotifyChannelId as string | undefined);
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL", d?.hitlNotifyWebhookUrl as string | undefined);
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_DM_USER_ID", d?.hitlNotifyDmUserId as string | undefined);
  if (d?.hitlReplyInSession === false) {
    setIfEmpty("SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION", "0");
  }
  if (d?.appendModelTagFooter === true) setIfEmpty("SHOGGOTH_DISCORD_MODEL_TAG", "1");
  if (d?.streamResponses === true) setIfEmpty("SHOGGOTH_DISCORD_STREAM", "1");
  if (d?.streamMinIntervalMs != null) {
    setIfEmpty("SHOGGOTH_DISCORD_STREAM_MIN_MS", String(d.streamMinIntervalMs));
  }
  setIfEmpty("SHOGGOTH_DISCORD_OWNER_USER_ID", d?.ownerUserId as string | undefined);
  if (r?.mcpLogServerMessages === true) setIfEmpty("SHOGGOTH_MCP_LOG_SERVER_MESSAGES", "1");
  setIfEmpty("SHOGGOTH_AGENT_ID", r?.agentId);
  const memEmb = cfg.memory?.embeddings;
  setIfEmpty("SHOGGOTH_MEMORY_OPENAI_BASE_URL", memEmb?.openaiBaseUrl);
  return base;
}
