/**
 * Lazy refs for service stores, set after daemon init.
 * Used by the control plane to access service stores that are created later in the boot sequence.
 */

import type { ServiceRegistry } from "./service-registry";
import type { ServiceToolRegistry } from "./service-tool-registry";
import type { ServiceApprovalStore } from "./service-approval-store";
import type { ServiceLifecycleManager } from "./service-lifecycle";

export const serviceRegistryRef: { current: ServiceRegistry | undefined } = {
  current: undefined,
};

export const serviceToolRegistryRef: { current: ServiceToolRegistry | undefined } = {
  current: undefined,
};

export const serviceApprovalStoreRef: { current: ServiceApprovalStore | undefined } = {
  current: undefined,
};

export const serviceLifecycleManagerRef: { current: ServiceLifecycleManager | undefined } = {
  current: undefined,
};
