import { parseAgentSessionUrn, resolvePlatformConfig, resolveAgentPlatformConfig, type ShoggothConfig } from "@shoggoth/shared";
import { parseDiscordRoutesWithMeta, type DiscordSessionRoute } from "@shoggoth/platform-discord";

function envInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function envPositiveInt(key: string): number | undefined {
  const n = envInt(key);
  if (n === undefined || n <= 0) return undefined;
  return n;
}

/** Env overrides layered config when the env var is set (non-empty). */
export function resolveDrainTimeoutMs(cfg: ShoggothConfig): number {
  return envPositiveInt("SHOGGOTH_DRAIN_TIMEOUT_MS") ?? cfg.runtime?.drainTimeoutMs ?? 30_000;
}

export function resolveBootStaleClaimMs(cfg: ShoggothConfig): number {
  return envInt("SHOGGOTH_STALE_CLAIM_MS") ?? cfg.runtime?.bootStaleClaimMs ?? 120_000;
}

export function resolveHeartbeatIntervalMs(cfg: ShoggothConfig): number {
  return envPositiveInt("SHOGGOTH_HEARTBEAT_MS") ?? cfg.runtime?.heartbeatIntervalMs ?? 5_000;
}

export function resolveCronTickIntervalMs(cfg: ShoggothConfig): number {
  return envPositiveInt("SHOGGOTH_CRON_TICK_MS") ?? cfg.runtime?.cronTickIntervalMs ?? 10_000;
}

export function resolveHeartbeatBatchSize(cfg: ShoggothConfig): number {
  return envPositiveInt("SHOGGOTH_HEARTBEAT_BATCH") ?? cfg.runtime?.heartbeatBatchSize ?? 32;
}

export function resolveHeartbeatConcurrency(cfg: ShoggothConfig): number {
  return envPositiveInt("SHOGGOTH_HEARTBEAT_CONCURRENCY") ?? cfg.runtime?.heartbeatConcurrency ?? 4;
}

/** `SHOGGOTH_CONFIG_HOT_RELOAD=0` disables; else `runtime.configHotReload: false` disables. */
export function isConfigHotReloadEnabled(cfg: ShoggothConfig): boolean {
  if (process.env.SHOGGOTH_CONFIG_HOT_RELOAD === "0") return false;
  if (cfg.runtime?.configHotReload === false) return false;
  return true;
}

/** Env `SHOGGOTH_AGENT_ID` wins; else `runtime.agentId`; default `main`. */
export function resolveShoggothAgentId(cfg: ShoggothConfig): string {
  const e = process.env.SHOGGOTH_AGENT_ID?.trim();
  if (e) return e;
  return cfg.runtime?.agentId?.trim() || "main";
}

/** Env `SHOGGOTH_DEFAULT_SESSION_PLATFORM` wins; else `runtime.defaultSessionPlatform`; else `"discord"`. */
export function resolveDefaultSessionPlatform(cfg: ShoggothConfig): string {
  const e = process.env.SHOGGOTH_DEFAULT_SESSION_PLATFORM?.trim();
  if (e) return e;
  return cfg.runtime?.defaultSessionPlatform?.trim() || "discord";
}

export function resolveDiscordRoutesJson(cfg: ShoggothConfig): string | undefined {
  const e = process.env.SHOGGOTH_DISCORD_ROUTES?.trim();
  if (e) return e;
  const dc = resolvePlatformConfig(cfg, "discord");
  return (dc?.routesJson as string | undefined)?.trim() || undefined;
}

/**
 * Global `discord.routesJson` plus `agents.list.<agentId>.discord.routes` (validated; session URNs must belong
 * to that agent key). Same-channel rows from agent blocks override global rows.
 */
export function resolveEffectiveDiscordRoutesJson(cfg: ShoggothConfig): string | undefined {
  const globalRaw = resolveDiscordRoutesJson(cfg);
  let globalRoutes: DiscordSessionRoute[] = [];
  if (globalRaw?.trim()) {
    try {
      globalRoutes = parseDiscordRoutesWithMeta(globalRaw).routes;
    } catch {
      globalRoutes = [];
    }
  }

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

  if (globalRoutes.length === 0 && fromAgents.length === 0) return undefined;

  const byChannel = new Map<string, DiscordSessionRoute>();
  for (const r of globalRoutes) {
    byChannel.set(r.channelId, r);
  }
  for (const r of fromAgents) {
    byChannel.set(r.channelId, r);
  }

  const merged = [...byChannel.values()];
  return JSON.stringify(
    merged.map((r) => ({
      channelId: r.channelId,
      sessionId: r.sessionId,
      ...(r.guildId ? { guildId: r.guildId } : {}),
    })),
  );
}

export function resolveDiscordIntents(cfg: ShoggothConfig): number | undefined {
  const raw = process.env.SHOGGOTH_DISCORD_INTENTS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  const dc = resolvePlatformConfig(cfg, "discord");
  return dc?.intents as number | undefined;
}

export function resolveDiscordAllowBotMessages(cfg: ShoggothConfig): boolean {
  const e = process.env.SHOGGOTH_DISCORD_ALLOW_BOT;
  if (e === "1") return true;
  if (e === "0") return false;
  const dc = resolvePlatformConfig(cfg, "discord");
  return dc?.allowBotMessages === true;
}

/** Env `SHOGGOTH_DISCORD_OWNER_USER_ID` wins; else layered `discord.ownerUserId`. */
export function resolveDiscordOwnerUserId(cfg: ShoggothConfig): string | undefined {
  const e = process.env.SHOGGOTH_DISCORD_OWNER_USER_ID?.trim();
  if (e) return e;
  const dc = resolvePlatformConfig(cfg, "discord");
  return (dc?.ownerUserId as string | undefined)?.trim() || undefined;
}

/**
 * Model endpoint health probe base URL. Env `ANTHROPIC_BASE_URL` (origin) is checked first for
 * Anthropic-style stacks; then `OPENAI_BASE_URL` / `OLLAMA_HOST`, then config.
 */
export function resolveModelHealthProbeBaseUrl(cfg: ShoggothConfig): string | undefined {
  const anthropic = process.env.ANTHROPIC_BASE_URL?.trim();
  if (anthropic) return anthropic;
  const openai = process.env.OPENAI_BASE_URL?.trim();
  if (openai) return openai;
  const ollama = process.env.OLLAMA_HOST?.trim();
  if (ollama) return ollama;
  const cOpenai = cfg.runtime?.openaiBaseUrl?.trim();
  if (cOpenai) return cOpenai;
  const cOllama = cfg.runtime?.ollamaHost?.trim();
  if (cOllama) return cOllama;
  return cfg.models?.providers?.[0]?.baseUrl?.trim() || undefined;
}

/**
 * Model endpoint health probe API key. Env vars checked first, then config.
 */
export function resolveModelHealthProbeApiKey(cfg: ShoggothConfig): string | undefined {
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return anthropic;
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) return openai;
  return cfg.models?.providers?.[0]?.apiKey?.trim() || undefined;
}

/**
 * Embeddings endpoint base URL from config.
 */
export function resolveEmbeddingsHealthProbeBaseUrl(cfg: ShoggothConfig): string | undefined {
  return cfg.memory?.embeddings?.openaiBaseUrl?.trim() || undefined;
}

/**
 * Embeddings endpoint API key from config.
 */
export function resolveEmbeddingsHealthProbeApiKey(cfg: ShoggothConfig): string | undefined {
  return cfg.memory?.embeddings?.apiKey?.trim() || undefined;
}

/**
 * Merges `discord` / `runtime` flags into env for code paths that still read `SHOGGOTH_*`.
 * **Precedence:** `override` (e.g. tests) > `process.env` > config-derived defaults.
 */
export function mergeOrchestratorEnv(cfg: ShoggothConfig, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...override };
  const d = resolvePlatformConfig(cfg, "discord");
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
  setIfEmpty("SHOGGOTH_DEFAULT_SESSION_PLATFORM", r?.defaultSessionPlatform);
  const memEmb = cfg.memory?.embeddings;
  setIfEmpty("SHOGGOTH_MEMORY_OPENAI_BASE_URL", memEmb?.openaiBaseUrl);
  return base;
}
