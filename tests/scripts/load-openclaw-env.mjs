#!/usr/bin/env node
/**
 * Prints POSIX `export NAME=value` lines for ad-hoc shells, sourced from OpenClaw config.
 * Usage: eval "$(node tests/scripts/load-openclaw-env.mjs)"
 *
 * **Docker stacks:** prefer repo `.env.shoggoth.local` (see `.env.shoggoth.example`) so Shoggoth uses its **own** Discord bot token;
 * compose overlays load that file — do not rely on this script for `DISCORD_BOT_TOKEN` in those flows.
 *
 * Reads OPENCLAW_CONFIG (default ~/.openclaw/openclaw.json). Does not print secrets to stderr.
 *
 * Precedence (which `models.providers.*` block is used):
 * 1. SHOGGOTH_READINESS_USE_LAN=1 → `models.providers.lan` only.
 * 2. Else SHOGGOTH_READINESS_PROVIDER=<id> → that key when it has `baseUrl`.
 * 3. Else first provider (other than `lan`) with `api: "anthropic-messages"` and `baseUrl`, if any.
 * 4. Else first provider (other than `lan`) with `baseUrl`, if any.
 * 5. Else `lan`.
 *
 * Protocol split (within the chosen block):
 * - OpenClaw `api` is `anthropic-messages` → export ANTHROPIC_BASE_URL (origin, no `/v1`), ANTHROPIC_API_KEY,
 *   SHOGGOTH_MODEL; do not put that API key in OPENAI_API_KEY. OPENAI_* are still exported as empty strings
 *   so compose/host defaults do not reuse a stale OPENAI_API_KEY from the parent shell.
 * - Otherwise (e.g. `openai-completions`) → export OPENAI_BASE_URL (normalized to trailing `/v1`), OPENAI_API_KEY,
 *   SHOGGOTH_MODEL; ANTHROPIC_* exported as empty strings for the same stale-env reason.
 *
 * For a model server on the Docker host: SHOGGOTH_READINESS_MODEL_HOST=host.docker.internal eval "..."
 */
import fs from "node:fs";
import { homedir } from "node:os";

const path = process.env.OPENCLAW_CONFIG ?? `${homedir()}/.openclaw/openclaw.json`;
const j = JSON.parse(fs.readFileSync(path, "utf8"));
const providers = j.models?.providers ?? {};
const lan = providers.lan;

function isAnthropicMessages(provider) {
  return provider?.api === "anthropic-messages";
}

/** Shoggoth OpenAI-compatible client expects a base URL ending in /v1. */
function normalizeOpenAiV1BaseUrl(raw) {
  const t = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!t) return "http://192.168.1.167:1234/v1";
  return /\/v1$/i.test(t) ? t : `${t}/v1`;
}

/** Anthropic Messages API uses `{origin}/v1/messages` — env should be origin only (no path suffix). */
function normalizeAnthropicOriginUrl(raw) {
  const t = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!t) return "http://192.168.1.167:1234";
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
  } catch {
    return t.replace(/\/v1\/?$/i, "");
  }
}

const preferLan = process.env.SHOGGOTH_READINESS_USE_LAN === "1";
let providerBlock;
if (preferLan) {
  providerBlock = lan;
} else {
  const explicit = process.env.SHOGGOTH_READINESS_PROVIDER?.trim();
  if (explicit && providers[explicit]?.baseUrl) {
    providerBlock = providers[explicit];
  } else {
    const entries = Object.entries(providers).filter(([, v]) => v && typeof v === "object" && v.baseUrl);
    const anthropic = entries.find(([k, v]) => k !== "lan" && isAnthropicMessages(v));
    const anyNamed = entries.find(([k]) => k !== "lan");
    providerBlock = anthropic?.[1] ?? anyNamed?.[1] ?? lan;
  }
}

let openaiBase;
let openaiApiKey;
let anthropicBase;
let anthropicApiKey;
let model;

if (isAnthropicMessages(providerBlock)) {
  anthropicBase = normalizeAnthropicOriginUrl(providerBlock.baseUrl);
  anthropicApiKey = providerBlock.apiKey ?? "";
  model = providerBlock.models?.[0]?.id ?? "claude-sonnet-4-20250514";
  openaiBase = "";
  openaiApiKey = "";
} else {
  openaiBase = normalizeOpenAiV1BaseUrl(
    providerBlock?.baseUrl ?? "http://192.168.1.167:1234/v1",
  );
  openaiApiKey = providerBlock?.apiKey ?? "";
  model = providerBlock?.models?.[0]?.id ?? "Qwen3";
  anthropicBase = "";
  anthropicApiKey = "";
}

const token = j.channels?.discord?.token ?? "";

/** If SHOGGOTH_READINESS_MODEL_HOST is set, replace URL hostname (OpenAI path: ensures `/v1`). */
function modelBaseUrlForDockerReadinessOpenAI(url) {
  const host = process.env.SHOGGOTH_READINESS_MODEL_HOST?.trim();
  if (!host) return url;
  try {
    const u = new URL(url);
    u.hostname = host;
    let out = u.toString().replace(/\/$/, "");
    if (!/\/v1$/i.test(out)) out = `${out}/v1`;
    return out;
  } catch {
    return url;
  }
}

/** Same host override for Anthropic origin URLs (no `/v1` suffix). */
function modelBaseUrlForDockerReadinessAnthropic(url) {
  const host = process.env.SHOGGOTH_READINESS_MODEL_HOST?.trim();
  if (!host) return url;
  try {
    const u = new URL(url);
    u.hostname = host;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function shExport(name, val) {
  process.stdout.write(`export ${name}=${JSON.stringify(String(val))}\n`);
}

shExport("DISCORD_BOT_TOKEN", token);
shExport("OPENAI_BASE_URL", modelBaseUrlForDockerReadinessOpenAI(openaiBase));
shExport("OPENAI_API_KEY", openaiApiKey);
shExport("ANTHROPIC_BASE_URL", modelBaseUrlForDockerReadinessAnthropic(anthropicBase));
shExport("ANTHROPIC_API_KEY", anthropicApiKey);
shExport("SHOGGOTH_MODEL", model);
