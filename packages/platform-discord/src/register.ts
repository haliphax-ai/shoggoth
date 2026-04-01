import {
  checkDiscordMessagingRouteSessionUrn,
  assertDiscordRoutesDefaultPrimaryUuidMatchesAgent,
  parseFirstDiscordChannelIdFromRoutesJson,
  resolveDiscordBootstrapPrimarySessionUrn,
} from "./messaging-urn-policy";
import { resolveEffectiveDiscordRoutesJson } from "./config";
import { registerMessagingPlatformUrnPolicy, type MessagingPlatformUrnPolicy } from "@shoggoth/messaging";
import type { ShoggothConfig } from "@shoggoth/shared";

const discordUrnPolicy: MessagingPlatformUrnPolicy = {
  platformId: "discord",
  checkRouteSessionUrn: checkDiscordMessagingRouteSessionUrn,
  assertRoutesDefaultPrimaryUuidMatchesAgent: assertDiscordRoutesDefaultPrimaryUuidMatchesAgent,
  parseFirstChannelIdFromRoutesJson: parseFirstDiscordChannelIdFromRoutesJson,
  resolveBootstrapPrimarySessionUrn: resolveDiscordBootstrapPrimarySessionUrn,
  resolveEffectiveRoutesJson: (cfg: unknown) => resolveEffectiveDiscordRoutesJson(cfg as ShoggothConfig),
};

let didRegister = false;

/** Idempotent: registers built-in transport URN policies (Discord, …). Call once during daemon / CLI startup. */
export function registerBuiltInMessagingPlatforms(): void {
  if (didRegister) return;
  didRegister = true;
  registerMessagingPlatformUrnPolicy(discordUrnPolicy);
}
