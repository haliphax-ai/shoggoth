import {
  formatAgentSessionUrn,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ParsedAgentSessionUrn,
} from "@shoggoth/shared";

/** Result of validating a `(session URN, channel id)` pair for a static route row. */
export type MessagingRouteSessionUrnCheck = "ok" | "drop" | { readonly fatal: string };

export interface BootstrapPrimarySessionUrnOptions {
  readonly primaryChannelId?: string | undefined;
}

/**
 * Per-platform session URN rules for routes parsing and bootstrap. Register implementations at process
 * startup; core resolves by the `platform` segment of `agent:<agentId>:<platform>:…`.
 */
export interface MessagingPlatformUrnPolicy {
  readonly platformId: string;
  checkRouteSessionUrn(parsed: ParsedAgentSessionUrn, channelId: string): MessagingRouteSessionUrnCheck;
  assertRoutesDefaultPrimaryUuidMatchesAgent(
    routes: ReadonlyArray<{ readonly sessionId: string }>,
    resolvedAgentId: string,
    resolvedPlatform: string,
    multiAgent?: unknown,
  ): void;
  parseFirstChannelIdFromRoutesJson(raw: string | undefined): string | undefined;
  resolveBootstrapPrimarySessionUrn(
    agentId: string,
    platform: string,
    options?: BootstrapPrimarySessionUrnOptions,
  ): string;
}

import { registerPlatform, getPlatformRegistration } from "./platform-registry";

/**
 * @deprecated Use {@link registerPlatform} instead. Thin wrapper for backward compatibility.
 */
export function registerMessagingPlatformUrnPolicy(policy: MessagingPlatformUrnPolicy): void {
  const k = policy.platformId.trim().toLowerCase();
  if (!k) throw new Error("MessagingPlatformUrnPolicy.platformId must be non-empty");
  // If already registered via the new registry, skip; otherwise register a minimal PlatformRegistration.
  if (!getPlatformRegistration(k)) {
    registerPlatform({
      platformId: policy.platformId,
      resourceTypes: ["unknown"],
      urnPolicy: policy,
    });
  }
}

/**
 * @deprecated Use {@link getPlatformRegistration} instead. Thin wrapper for backward compatibility.
 */
export function getMessagingPlatformUrnPolicy(platformId: string): MessagingPlatformUrnPolicy | undefined {
  return getPlatformRegistration(platformId)?.urnPolicy;
}

export function resolveBootstrapPrimarySessionUrn(
  agentId: string,
  platform: string,
  options?: BootstrapPrimarySessionUrnOptions,
): string {
  const p = getMessagingPlatformUrnPolicy(platform.trim().toLowerCase());
  if (p) return p.resolveBootstrapPrimarySessionUrn(agentId, platform, options);
  return formatAgentSessionUrn(agentId, platform, "channel", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
}

export function parseFirstChannelIdFromRoutesJson(
  platform: string,
  raw: string | undefined,
): string | undefined {
  return getMessagingPlatformUrnPolicy(platform.trim().toLowerCase())?.parseFirstChannelIdFromRoutesJson(raw);
}
