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

import { getPlatformRegistration } from "./platform-registry";

export function resolveBootstrapPrimarySessionUrn(
  agentId: string,
  platform: string,
  options?: BootstrapPrimarySessionUrnOptions,
): string {
  const reg = getPlatformRegistration(platform.trim().toLowerCase());
  if (reg) return reg.urnPolicy.resolveBootstrapPrimarySessionUrn(agentId, platform, options);
  return formatAgentSessionUrn(agentId, platform, "channel", SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID);
}

export function parseFirstChannelIdFromRoutesJson(
  platform: string,
  raw: string | undefined,
): string | undefined {
  return getPlatformRegistration(platform.trim().toLowerCase())?.urnPolicy.parseFirstChannelIdFromRoutesJson(raw);
}
