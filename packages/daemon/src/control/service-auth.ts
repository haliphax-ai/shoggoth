/**
 * Service Control Plane Auth - Authentication and authorization for service control plane access
 *
 * Phase 5: Scoped Control Plane Access for Services
 */

import { ServiceKeyStore } from "../service-key-store";
import { TokenValidator } from "../service-auth";

export interface ServiceControlPlaneAuth {
  /**
   * Authenticate a service using a proof (token/signature)
   */
  authenticate(serviceId: string, proof: string): Promise<boolean>;

  /**
   * Check if an operation is allowed for a service
   */
  isOperationAllowed(serviceId: string, op: string): boolean;
}

export class ServiceControlPlaneAuthImpl implements ServiceControlPlaneAuth {
  private keyStore: ServiceKeyStore;

  constructor(keyStore: ServiceKeyStore) {
    this.keyStore = keyStore;
  }

  async authenticate(serviceId: string, proof: string): Promise<boolean> {
    // Check if the service is approved
    const isApproved = await this.keyStore.isApproved(serviceId);
    if (!isApproved) {
      return false;
    }

    // Get the service's identity for token validation
    const identityString = await this.keyStore.getIdentity(serviceId);
    if (!identityString) {
      return false;
    }

    // Validate the proof token
    const payload = await TokenValidator.validate(proof, identityString);
    if (!payload) {
      return false;
    }

    // Ensure the token is for this service
    if (payload.scope !== serviceId) {
      return false;
    }

    return true;
  }

  isOperationAllowed(serviceId: string, op: string): boolean {
    // Check if the service is approved
    const isApproved = this.keyStore.isApproved(serviceId);
    if (!isApproved) {
      return false;
    }

    // Check if the operation is in the approved ops list
    const approvedOps = this.keyStore.getApprovedOps(serviceId);
    return approvedOps.includes(op);
  }
}
