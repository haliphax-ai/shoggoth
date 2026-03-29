import type { ShoggothConfig } from "@shoggoth/shared";

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

export function resolveDiscordRoutesJson(cfg: ShoggothConfig): string | undefined {
  const e = process.env.SHOGGOTH_DISCORD_ROUTES?.trim();
  if (e) return e;
  return cfg.discord?.routesJson?.trim() || undefined;
}

export function resolveDiscordIntents(cfg: ShoggothConfig): number | undefined {
  const raw = process.env.SHOGGOTH_DISCORD_INTENTS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return cfg.discord?.intents;
}

export function resolveDiscordAllowBotMessages(cfg: ShoggothConfig): boolean {
  const e = process.env.SHOGGOTH_DISCORD_ALLOW_BOT;
  if (e === "1") return true;
  if (e === "0") return false;
  return cfg.discord?.allowBotMessages === true;
}

/**
 * Model endpoint health probe base URL. Env `ANTHROPIC_BASE_URL` (origin) is checked first for
 * Kiro / Anthropic stacks; then `OPENAI_BASE_URL` / `OLLAMA_HOST`, then config.
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
 * Merges `discord` / `runtime` flags into env for code paths that still read `SHOGGOTH_*`.
 * **Precedence:** `override` (e.g. tests) > `process.env` > config-derived defaults.
 */
export function mergeOrchestratorEnv(cfg: ShoggothConfig, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...override };
  const d = cfg.discord;
  const r = cfg.runtime;
  const setIfEmpty = (key: string, val: string | undefined) => {
    if (val === undefined || val === "") return;
    const cur = base[key];
    if (cur === undefined || cur === "") base[key] = val;
  };
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_CHANNEL_ID", d?.hitlNotifyChannelId);
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL", d?.hitlNotifyWebhookUrl);
  setIfEmpty("SHOGGOTH_HITL_NOTIFY_DM_USER_ID", d?.hitlNotifyDmUserId);
  if (d?.hitlReplyInSession === false) {
    setIfEmpty("SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION", "0");
  }
  if (d?.appendModelTagFooter === true) setIfEmpty("SHOGGOTH_DISCORD_MODEL_TAG", "1");
  if (d?.streamResponses === true) setIfEmpty("SHOGGOTH_DISCORD_STREAM", "1");
  if (d?.streamMinIntervalMs != null) {
    setIfEmpty("SHOGGOTH_DISCORD_STREAM_MIN_MS", String(d.streamMinIntervalMs));
  }
  if (r?.mcpLogServerMessages === true) setIfEmpty("SHOGGOTH_MCP_LOG_SERVER_MESSAGES", "1");
  const memEmb = cfg.memory?.embeddings;
  setIfEmpty("SHOGGOTH_MEMORY_OPENAI_BASE_URL", memEmb?.openaiBaseUrl);
  return base;
}
