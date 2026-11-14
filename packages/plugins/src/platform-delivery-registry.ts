// -------------------------------------------------------------------------------
// Platform Delivery Registry — platform-agnostic operator delivery resolution
//
// Plugins register a resolver for their platform segment (e.g. "discord").
// The daemon uses this to determine how to reach the operator on a given session's
// platform without knowing platform-specific details.
// -------------------------------------------------------------------------------

import type { ShoggothConfig } from "@shoggoth/shared";

/**
 * Delivery metadata returned by a platform plugin.
 * Opaque to the daemon — it just passes this through to the delivery layer.
 */
export type OperatorDelivery =
  | { readonly kind: "messaging_surface"; readonly userId: string }
  | { readonly kind: "internal" };

/**
 * A platform plugin implements this to tell the daemon how to reach the operator
 * on sessions it owns.
 */
export interface PlatformDeliveryResolver {
  /**
   * Given a session URN owned by this platform, return delivery metadata
   * for reaching the operator. Return undefined if no operator delivery is configured.
   */
  resolveOperatorDelivery(
    sessionId: string,
    config: Readonly<ShoggothConfig>,
  ): OperatorDelivery | undefined;

  /**
   * Given platform-specific inbound identifiers, resolve to a session ID.
   * The shape of `identifiers` is platform-specific and opaque to the daemon.
   */
  resolveSessionForInbound?(
    identifiers: Record<string, string>,
    config: Readonly<ShoggothConfig>,
  ): string | undefined;
}

/**
 * Registry of platform delivery resolvers, keyed by platform segment.
 * The daemon holds one instance; plugins register during platform.start.
 */
export class PlatformDeliveryRegistry {
  private readonly resolvers = new Map<string, PlatformDeliveryResolver>();

  register(platformSegment: string, resolver: PlatformDeliveryResolver): void {
    this.resolvers.set(platformSegment, resolver);
  }

  /**
   * Resolve operator delivery for a session URN.
   * Extracts the platform segment from the URN and delegates to the registered resolver.
   */
  resolveOperatorDelivery(
    sessionId: string,
    config: Readonly<ShoggothConfig>,
  ): OperatorDelivery | undefined {
    const segment = extractPlatformSegment(sessionId);
    if (!segment) return undefined;
    const resolver = this.resolvers.get(segment);
    return resolver?.resolveOperatorDelivery(sessionId, config);
  }

  resolveSessionForInbound(
    platformSegment: string,
    identifiers: Record<string, string>,
    config: Readonly<ShoggothConfig>,
  ): string | undefined {
    const resolver = this.resolvers.get(platformSegment);
    return resolver?.resolveSessionForInbound?.(identifiers, config);
  }
}

/**
 * Extract the platform segment from a session URN.
 * URN pattern: `<entity type>:<entity id>:<platform>:<resource type>:<resource id>`
 * e.g. `agent:main:discord:channel:123456`
 */
function extractPlatformSegment(sessionId: string): string | undefined {
  if (!sessionId.trim()) throw new Error("sessionId must be a non-empty string");
  const parts = sessionId.split(":");
  // agent:main:discord:channel:123 → parts[2] = "discord"
  const platform = parts.length >= 3 ? parts[2] : undefined;
  if (parts.length >= 3 && !platform?.trim()) {
    throw new Error(`session URN platform segment must be non-empty: ${JSON.stringify(sessionId)}`);
  }
  return platform;
}
