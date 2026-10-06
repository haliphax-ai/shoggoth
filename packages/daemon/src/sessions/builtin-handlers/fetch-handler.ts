// ---------------------------------------------------------------------------
// fetch handler — structured HTTP client
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fetch as undiciFetch, Agent } from "undici";
import { isPrivateIp } from "@shoggoth/shared";
import { validateCaBundleContent } from "../../config/validate-fetch-ca-bundle";
import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import { truncateToolOutput } from "./truncate-output";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function register(registry: BuiltinToolRegistry): void {
  registry.register("fetch", fetchHandler);
}

// ---------------------------------------------------------------------------
// Dispatcher cache — every request goes through undici's fetch with one of
// these dispatchers; only the dispatcher config differs.
// ---------------------------------------------------------------------------

let defaultDispatcher: Agent | undefined;
let cachedCaBundlePath: string | undefined;
let cachedCaAgent: Agent | undefined;

/**
 * Resolve the undici dispatcher for a request. Without a configured CA
 * bundle a plain default Agent is built once and reused; with one, an Agent
 * trusting the PEM certificate bundle at the configured path is built and
 * cached per resolved path for the process lifetime (when the path changes,
 * the previous agent is left open so in-flight requests using it can finish;
 * its idle sockets close after undici's keep-alive timeout).
 *
 * Throws if the bundle file is missing, unreadable, or not a valid PEM
 * certificate bundle.
 */
function getDispatcher(caBundlePath: string | undefined): Agent {
  if (!caBundlePath) return (defaultDispatcher ??= new Agent());
  const resolvedPath = resolvePath(caBundlePath);
  if (cachedCaAgent && cachedCaBundlePath === resolvedPath) return cachedCaAgent;
  const pem = readFileSync(resolvedPath, "utf8");
  // Fail fast with a clear error on malformed bundles instead of a cryptic
  // TLS failure mid-request (same check as the startup validation).
  const validation = validateCaBundleContent(pem);
  if (!validation.ok) {
    throw new Error(`${resolvedPath}: ${validation.reason}`);
  }
  cachedCaAgent = new Agent({ connect: { ca: pem } });
  cachedCaBundlePath = resolvedPath;
  return cachedCaAgent;
}

// ---------------------------------------------------------------------------
// CIDR matching
// ---------------------------------------------------------------------------

function parseCidr(cidr: string): { ip: number[]; prefixLen: number; version: 4 | 6 } | null {
  const slash = cidr.lastIndexOf("/");
  if (slash === -1) return null;
  const ipStr = cidr.slice(0, slash);
  const prefixLen = parseInt(cidr.slice(slash + 1), 10);
  if (isNaN(prefixLen)) return null;

  if (ipStr.includes(":")) {
    const expanded = expandIPv6(ipStr);
    if (!expanded) return null;
    const groups = expanded.split(":").map((g) => parseInt(g, 16));
    if (groups.length !== 8 || prefixLen < 0 || prefixLen > 128) return null;
    // Flatten to 16 bytes
    const bytes: number[] = [];
    for (const g of groups) {
      bytes.push((g >> 8) & 0xff, g & 0xff);
    }
    return { ip: bytes, prefixLen, version: 6 };
  }

  const parts = ipStr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;
  if (prefixLen < 0 || prefixLen > 32) return null;
  return { ip: parts, prefixLen, version: 4 };
}

function ipMatchesCidr(ipStr: string, cidr: ReturnType<typeof parseCidr>): boolean {
  if (!cidr) return false;

  if (cidr.version === 4) {
    const parts = ipStr.split(".").map(Number);
    if (parts.length !== 4) return false;
    // Compare prefix bits
    for (let bit = 0; bit < cidr.prefixLen; bit++) {
      const byteIdx = bit >> 3;
      const bitMask = 0x80 >> (bit & 7);
      if ((parts[byteIdx] & bitMask) !== (cidr.ip[byteIdx] & bitMask)) return false;
    }
    return true;
  }

  // IPv6
  const expanded = expandIPv6(ipStr);
  if (!expanded) return false;
  const groups = expanded.split(":").map((g) => parseInt(g, 16));
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >> 8) & 0xff, g & 0xff);
  }
  for (let bit = 0; bit < cidr.prefixLen; bit++) {
    const byteIdx = bit >> 3;
    const bitMask = 0x80 >> (bit & 7);
    if ((bytes[byteIdx] & bitMask) !== (cidr.ip[byteIdx] & bitMask)) return false;
  }
  return true;
}

function expandIPv6(addr: string): string | null {
  let halves: string[];
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    halves = [...leftGroups, ...Array(missing).fill("0"), ...rightGroups];
  } else {
    halves = addr.split(":");
  }
  if (halves.length !== 8) return null;
  return halves.map((g) => g.padStart(4, "0")).join(":");
}

// ---------------------------------------------------------------------------
// Private IP check with allowlist support
// ---------------------------------------------------------------------------

function isIpAllowed(
  ip: string,
  hostname: string,
  allowPrivateIps: boolean,
  allowlist: string[],
): boolean {
  if (!isPrivateIp(ip)) return true; // public IP — always allowed
  if (allowPrivateIps) return true;

  // Check allowlist: entries can be CIDR ranges or hostnames
  for (const entry of allowlist) {
    // Hostname match
    if (entry === hostname) return true;
    // CIDR match
    const cidr = parseCidr(entry);
    if (cidr && ipMatchesCidr(ip, cidr)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function fetchHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const url = args.url as string | undefined;
  if (!url || typeof url !== "string") {
    return {
      resultJson: JSON.stringify({
        error: "url is required and must be a string",
      }),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { resultJson: JSON.stringify({ error: `Invalid URL: ${url}` }) };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      resultJson: JSON.stringify({
        error: `Unsupported protocol: ${parsed.protocol}`,
      }),
    };
  }

  const method = ((args.method as string) ?? "GET").toUpperCase();
  if (!VALID_METHODS.has(method)) {
    return {
      resultJson: JSON.stringify({
        error: `Unsupported HTTP method: ${method}`,
      }),
    };
  }

  const maxResponseBytes = Math.max(
    (args.maxResponseBytes as number) ?? DEFAULT_MAX_RESPONSE_BYTES,
    0,
  );
  const timeoutMs = Math.max((args.timeoutMs as number) ?? DEFAULT_TIMEOUT_MS, 0);
  const binary = (args.binary as boolean) ?? false;

  // --- Fetch config from runtime config ---
  const fetchConfig = (ctx.config as Record<string, unknown>).fetch as
    | { allowPrivateIps?: boolean; privateIpAllowlist?: string[]; caBundle?: string }
    | undefined;
  const allowPrivateIps = fetchConfig?.allowPrivateIps ?? false;
  const privateIpAllowlist = fetchConfig?.privateIpAllowlist ?? [];

  // --- Private IP check: resolve hostname first ---
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  try {
    const resolved = await lookup(hostname, { all: true });
    for (const entry of resolved) {
      if (!isIpAllowed(entry.address, hostname, allowPrivateIps, privateIpAllowlist)) {
        return {
          resultJson: JSON.stringify({
            error: `Blocked: ${hostname} resolves to private/internal IP ${entry.address}. Configure fetch.allowPrivateIps or fetch.privateIpAllowlist to permit.`,
          }),
        };
      }
    }
  } catch (err: unknown) {
    return {
      resultJson: JSON.stringify({
        error: `DNS resolution failed for ${hostname}: ${(err as Error).message}`,
      }),
    };
  }

  // --- Build request ---
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
      headers[k] = String(v);
    }
  }

  let bodyPayload: string | undefined;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === "object") {
      bodyPayload = JSON.stringify(args.body);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    } else {
      bodyPayload = String(args.body);
    }
  }

  // --- Resolve dispatcher (cached; loads the CA bundle on first use) ---
  let dispatcher: Agent;
  try {
    dispatcher = getDispatcher(fetchConfig?.caBundle);
  } catch (err: unknown) {
    return {
      resultJson: JSON.stringify({
        error: `Failed to load CA bundle: ${(err as Error).message}`,
      }),
    };
  }

  // --- Execute fetch ---
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = (await undiciFetch(parsed.href, {
      method,
      headers,
      body: bodyPayload,
      signal: controller.signal,
      redirect: "manual", // no redirect following by default
      dispatcher,
    })) as unknown as Response;
    clearTimeout(timer);

    // --- Read response body with cap ---
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    if (res.body) {
      const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (totalBytes + chunk.length > maxResponseBytes) {
            const remaining = maxResponseBytes - totalBytes;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            totalBytes += chunk.length;
            truncated = true;
            reader.cancel().catch(() => {});
            break;
          }
          chunks.push(chunk);
          totalBytes += chunk.length;
        }
      } catch {
        // stream error after partial read — use what we have
      }
    }

    const rawBuf = Buffer.concat(chunks);
    const bodyBytes = totalBytes;

    // --- Format body ---
    let body: string;
    if (binary) {
      body = rawBuf.toString("base64");
    } else {
      body = rawBuf.toString("utf-8");
      // Pretty-print JSON responses
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json") || ct.includes("+json")) {
        try {
          body = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          // not valid JSON — keep raw text
        }
      }
    }

    if (truncated) {
      body += "\n\n[truncated — response exceeded maxResponseBytes]";
    }

    // --- Build response headers map ---
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    return {
      resultJson: JSON.stringify({
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: truncateToolOutput(body),
        truncated,
        bodyBytes,
      }),
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return {
        resultJson: JSON.stringify({
          error: `Request timed out after ${timeoutMs}ms`,
        }),
      };
    }
    // Network/TLS failures surface as a generic "fetch failed" wrapper with
    // the real reason (e.g. "self-signed certificate") in `cause`.
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : (err as Error).message;
    return {
      resultJson: JSON.stringify({
        error: `Fetch failed: ${detail}`,
      }),
    };
  }
}
