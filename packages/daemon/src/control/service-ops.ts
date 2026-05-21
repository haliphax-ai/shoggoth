/**
 * Control plane service operations.
 */

import type { WireRequest } from "@shoggoth/authn";
import type { AuthenticatedPrincipal } from "@shoggoth/authn";
import type { IntegrationOpsContext } from "./integration-ops";
import type { ServiceApprovalStore } from "../service-approval-store";
import type { ServiceRegistry, ServiceEntry } from "../service-registry";
import type { ServiceToolRegistry } from "../service-tool-registry";
import type { ServiceKeyStore } from "../service-key-store.js";
import { createHash } from "node:crypto";
import { serviceLifecycleManagerRef, serviceProvisionSecrets } from "../service-refs";

/**
 * Extract the service approval store from the integration context.
 */
function requireApprovalStore(ctx: IntegrationOpsContext): ServiceApprovalStore {
  const store = (ctx as { serviceApprovalStore?: ServiceApprovalStore }).serviceApprovalStore;
  if (!store) {
    throw new Error("service approval store not available");
  }
  return store;
}

/**
 * Extract the service registry from the integration context.
 */
function requireServiceRegistry(ctx: IntegrationOpsContext): ServiceRegistry {
  const registry = (ctx as { serviceRegistry?: ServiceRegistry }).serviceRegistry;
  if (!registry) {
    throw new Error("service registry not available");
  }
  return registry;
}

/**
 * Extract the service tool registry from the integration context.
 */
function requireToolRegistry(ctx: IntegrationOpsContext): ServiceToolRegistry {
  const registry = (ctx as { serviceToolRegistry?: ServiceToolRegistry }).serviceToolRegistry;
  if (!registry) {
    throw new Error("service tool registry not available");
  }
  return registry;
}

/**
 * Extract the service key store from the integration context.
 * Returns null if not configured (key provisioning will be skipped).
 */
function getKeyStore(ctx: IntegrationOpsContext): ServiceKeyStore | null {
  const store = (ctx as { serviceKeyStore?: ServiceKeyStore }).serviceKeyStore;
  return store ?? null;
}

/**
 * Helper to get payload object from request.
 */
function getPayload(req: WireRequest): Record<string, unknown> {
  const p = req.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new Error("payload must be a JSON object");
  }
  return p as Record<string, unknown>;
}

/**
 * Helper to require a string from payload.
 */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`payload.${key} must be a non-empty string`);
  }
  return v.trim();
}

/**
 * Compute a fingerprint for a service manifest.
 */
function computeFingerprint(entry: ServiceEntry): string {
  const data = JSON.stringify({
    id: entry.id,
    label: entry.label,
    capabilities: entry.capabilities,
    tools: entry.manifest?.tools ?? [],
    ops: entry.manifest?.ops ?? [],
  });
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Deliver an identity to a service via POST {url}/_shoggoth/identity.
 * Includes X-Provision-Secret header for authentication (initial provisioning).
 * Returns true if delivery succeeded, false otherwise.
 */
async function deliverIdentity(
  serviceUrl: string,
  identity: string,
  provisionSecret: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serviceUrl}/_shoggoth/identity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provision-Secret": provisionSecret,
      },
      body: JSON.stringify({ identity }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Deliver a rotated identity to a service via POST {url}/_shoggoth/identity.
 * Authenticates with a Bearer token minted using the current key (proves daemon identity).
 * Returns true if delivery succeeded, false otherwise.
 */
async function deliverRotatedIdentity(
  serviceUrl: string,
  newIdentity: string,
  rotationToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serviceUrl}/_shoggoth/identity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rotationToken}`,
      },
      body: JSON.stringify({ identity: newIdentity }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Handle service.list control operation.
 * Returns all services from the registry.
 */
export async function handleServiceList(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.list requires operator principal" };
  }

  try {
    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const toolRegistry = requireToolRegistry(ctx);
    const keyStore = getKeyStore(ctx);

    // Get all approval records
    const approvals = approvalStore.list();

    // Get all registry entries
    const registryEntries = serviceRegistry.list();

    // Get tools list safely
    let toolsByService: Map<string, Array<{ qualifiedName: string; description: string }>>;
    try {
      const tools = toolRegistry.listTools();
      toolsByService = new Map();
      for (const tool of tools) {
        const existing = toolsByService.get(tool.serviceId) ?? [];
        existing.push({ qualifiedName: tool.qualifiedName, description: tool.description });
        toolsByService.set(tool.serviceId, existing);
      }
    } catch {
      // Tool registry might not have listTools in test mocks
      toolsByService = new Map();
    }

    // Build combined view - only from registry entries
    const serviceMap = new Map<
      string,
      {
        id: string;
        label?: string;
        tier: string;
        status: string;
        url?: string;
        healthy: boolean;
        capabilities: string[];
        tools: number;
        key_fingerprint?: string;
      }
    >();

    for (const entry of registryEntries) {
      const approval = approvals.find((a) => a.serviceId === entry.id);
      const keyFingerprint = keyStore?.getFingerprint(entry.id) ?? null;
      serviceMap.set(entry.id, {
        id: entry.id,
        label: entry.label,
        tier: entry.tier,
        status: approval?.status ?? entry.approvalStatus,
        url: entry.url ?? undefined,
        healthy: entry.healthy,
        capabilities: entry.capabilities,
        tools: (toolsByService.get(entry.id) ?? []).length,
        ...(keyFingerprint ? { key_fingerprint: keyFingerprint } : {}),
      });
    }

    return { services: Array.from(serviceMap.values()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Handle service.requests control operation.
 * Returns pending and pending-reapproval services.
 */
export async function handleServiceRequests(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.requests requires operator principal" };
  }

  try {
    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);

    // Get pending and pending-reapproval records (status filter handles both)
    const allApprovals = approvalStore.list();
    const pendingApprovals = allApprovals.filter(
      (a) => a.status === "pending" || a.status === "pending-reapproval",
    );

    const requests: Array<{
      id: string;
      label?: string;
      status: string;
      tier?: string;
      capabilities: string[];
      updatedAt: string;
    }> = [];

    for (const approval of pendingApprovals) {
      const entry = serviceRegistry.get(approval.serviceId);
      requests.push({
        id: approval.serviceId,
        label: entry?.label,
        status: approval.status,
        tier: entry?.tier,
        capabilities: entry?.capabilities ?? [],
        updatedAt: approval.updatedAt,
      });
    }

    return { requests };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Handle service.request control operation.
 * Returns details for a specific service.
 */
export async function handleServiceRequest(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.request requires operator principal" };
  }

  try {
    const payload = getPayload(req);
    const serviceId = requireString(payload, "service_id");

    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const toolRegistry = requireToolRegistry(ctx);

    const approval = approvalStore.get(serviceId);
    const entry = serviceRegistry.get(serviceId);

    if (!approval && !entry) {
      return { error: `Service '${serviceId}' not found` };
    }

    const status = approval?.status ?? entry?.approvalStatus ?? "pending";
    const tools = entry?.manifest?.tools ?? [];

    // Get registered tools for this service
    let registeredTools: Array<{ qualifiedName: string; serviceId: string; description: string }> =
      [];
    try {
      registeredTools = toolRegistry.listTools().filter((t) => t.serviceId === serviceId);
    } catch {
      // Tool registry might not have listTools in test mocks
    }

    // Build diff info for pending-reapproval
    let diff: { oldFingerprint: string; newFingerprint: string; changes: string[] } | undefined;
    if (status === "pending-reapproval" && approval?.approvedFingerprint && entry) {
      const newFingerprint = computeFingerprint(entry);
      const changes: string[] = [];

      const oldFingerprint = approval.approvedFingerprint;
      if (oldFingerprint !== newFingerprint) {
        changes.push("Service manifest changed");
      }

      diff = {
        oldFingerprint,
        newFingerprint,
        changes,
      };
    }

    return {
      service: {
        id: serviceId,
        label: entry?.label,
        tier: entry?.tier,
        status,
        url: entry?.url,
        healthy: entry?.healthy ?? false,
        capabilities: entry?.capabilities ?? [],
        ops: entry?.manifest?.ops ?? [],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          method: t.method,
          path: t.path,
        })),
        registeredTools: registeredTools.map((t) => t.qualifiedName),
        createdAt: approval?.createdAt,
        updatedAt: approval?.updatedAt,
        diff,
      },
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("service_id")) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Handle service.approve control operation.
 * Approves a service and stores the fingerprint.
 * Generates an age identity key and delivers it to the service.
 * Requires the service to be running with a manifest (otherwise there's nothing to fingerprint).
 */
export async function handleServiceApprove(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.approve requires operator principal" };
  }

  try {
    const payload = getPayload(req);
    const serviceId = requireString(payload, "service_id");

    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const keyStore = getKeyStore(ctx);

    const entry = serviceRegistry.get(serviceId);

    // Service must be running with a manifest to approve
    if (!entry) {
      return { error: `Service '${serviceId}' not found in registry (is it running?)` };
    }

    if (!entry.manifest) {
      return { error: `Service '${serviceId}' has no manifest (cannot compute fingerprint)` };
    }

    // Compute fingerprint from current manifest
    const fingerprint = computeFingerprint(entry);

    // Generate age identity key for the service (if key store is available)
    let delivery: "delivered" | "pending" | undefined;
    let keyFingerprint: string | null = null;

    if (keyStore) {
      const keyPair = await keyStore.generateIdentity(serviceId);

      // Deliver identity to the service
      // Deliver identity to the service
      delivery = "pending";
      if (entry.url) {
        // Use the provision secret that was injected at spawn time
        const provisionSecret = serviceProvisionSecrets.get(serviceId);
        if (provisionSecret) {
          const delivered = await deliverIdentity(entry.url, keyPair.identity, provisionSecret);
          if (delivered) {
            delivery = "delivered";
          } else {
            // Log warning but don't fail the approval
            console.warn(
              `[service-ops] Failed to deliver identity to service '${serviceId}' at ${entry.url}/_shoggoth/identity`,
            );
          }
        } else {
          // No stored secret — service wasn't spawned by procman (external) or was restarted outside our control
          console.warn(
            `[service-ops] No provision secret for service '${serviceId}' — cannot deliver identity automatically`,
          );
        }
      }

      keyFingerprint = keyStore.getFingerprint(serviceId);
    }

    // Use lifecycle manager to approve (handles store + registry + tool registration)
    const lifecycleManager = serviceLifecycleManagerRef.current;
    if (lifecycleManager) {
      lifecycleManager.onServiceApproved(serviceId);
    } else {
      // Fallback: approve in store and registry without tool registration
      approvalStore.approve(serviceId, fingerprint);
      if (typeof serviceRegistry.setApprovalStatus === "function") {
        serviceRegistry.setApprovalStatus(serviceId, "approved");
      }
    }

    // Update approval record with key fingerprint if upsert is available
    if (keyFingerprint && typeof approvalStore.upsert === "function") {
      approvalStore.upsert(serviceId, "approved", fingerprint, keyFingerprint);
    }

    return {
      ok: true,
      service_id: serviceId,
      fingerprint,
      ...(keyFingerprint ? { key_fingerprint: keyFingerprint } : {}),
      ...(delivery ? { delivery } : {}),
    };
  } catch (e) {
    if (e instanceof Error && e.message.includes("service_id")) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Handle service.rotate-key control operation.
 * Rotates the age identity key for a service and delivers the new identity.
 */
export async function handleServiceRotateKey(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.rotate-key requires operator principal" };
  }

  try {
    const payload = getPayload(req);
    const serviceId = requireString(payload, "service_id");

    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const keyStore = getKeyStore(ctx);
    if (!keyStore) {
      return { error: "service key store not available" };
    }

    const entry = serviceRegistry.get(serviceId);
    if (!entry) {
      return { error: `Service '${serviceId}' not found in registry (is it running?)` };
    }

    // Service must have an existing key to rotate
    if (!keyStore.hasIdentity(serviceId)) {
      return { error: `Service '${serviceId}' has no existing key to rotate` };
    }

    // Mint a rotation token with the current key (proves daemon identity to the service)
    const { tokenMinterRef } = await import("../service-refs");
    const tokenMinter = tokenMinterRef.current;
    let rotationToken: string | null = null;
    if (tokenMinter) {
      try {
        rotationToken = await tokenMinter.mint("daemon", serviceId);
      } catch {
        // If minting fails, we can't authenticate the rotation
      }
    }

    // Rotate the key (generates new pair, replaces stored recipient)
    const keyPair = await keyStore.rotateIdentity(serviceId);

    // Deliver new identity to the service
    let delivery: "delivered" | "pending" = "pending";
    if (entry.url && rotationToken) {
      const delivered = await deliverRotatedIdentity(entry.url, keyPair.identity, rotationToken);
      if (delivered) {
        delivery = "delivered";
      } else {
        console.warn(
          `[service-ops] Failed to deliver rotated identity to service '${serviceId}' at ${entry.url}/_shoggoth/identity`,
        );
      }
    } else if (entry.url && !rotationToken) {
      console.warn(
        `[service-ops] Cannot deliver rotated identity to '${serviceId}' — no token minter available`,
      );
    }
    // Update approval record fingerprint
    const keyFingerprint = keyStore.getFingerprint(serviceId);
    const approval = approvalStore.get(serviceId);
    if (approval && keyFingerprint) {
      approvalStore.upsert(
        serviceId,
        approval.status,
        approval.approvedFingerprint ?? undefined,
        keyFingerprint,
      );
    }

    return { ok: true, service_id: serviceId, key_fingerprint: keyFingerprint, delivery };
  } catch (e) {
    if (e instanceof Error && e.message.includes("service_id")) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleServiceRevoke(
  req: WireRequest,
  principal: AuthenticatedPrincipal,
  ctx: IntegrationOpsContext,
): Promise<unknown> {
  if (principal.kind !== "operator") {
    return { error: "service.revoke requires operator principal" };
  }

  try {
    const payload = getPayload(req);
    const serviceId = requireString(payload, "service_id");

    const approvalStore = requireApprovalStore(ctx);
    const serviceRegistry = requireServiceRegistry(ctx);
    const toolRegistry = requireToolRegistry(ctx);
    const keyStore = getKeyStore(ctx);

    // Check if service exists
    const entry = serviceRegistry.get(serviceId);

    // Delete key material from ServiceKeyStore (if available)
    if (keyStore) {
      keyStore.deleteIdentity(serviceId);
    }

    // Use lifecycle manager to revoke (handles store + registry + tool deregistration)
    const lifecycleManager = serviceLifecycleManagerRef.current;
    if (lifecycleManager) {
      lifecycleManager.onServiceRevoked(serviceId);
    } else {
      // Fallback: revoke in store and deregister tools directly
      approvalStore.revoke(serviceId);
      if (entry) {
        if (typeof toolRegistry.deregisterServiceTools === "function") {
          toolRegistry.deregisterServiceTools(serviceId);
        }
        if (typeof serviceRegistry.setApprovalStatus === "function") {
          serviceRegistry.setApprovalStatus(serviceId, "revoked");
        }
      }
    }

    return { ok: true, service_id: serviceId };
  } catch (e) {
    if (e instanceof Error && e.message.includes("service_id")) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
