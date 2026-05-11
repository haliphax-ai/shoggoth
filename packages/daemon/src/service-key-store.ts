/**
 * Service Key Store - Manages per-service age identities
 *
 * Phase 2: Auth - Per-Service Age Identities
 */

import * as age from "age-encryption";

export interface ServiceRegistration {
  id: string;
  recipient: string;
  approvedOps: string[];
  approved: boolean;
}

interface StoredRegistration {
  recipient: string;
  identityString: string;
  approvedOps: string[];
  approved: boolean;
}

export class ServiceKeyStore {
  private secretsDir: string;
  private registrations: Map<string, StoredRegistration> = new Map();

  constructor(secretsDir: string) {
    this.secretsDir = secretsDir;
  }

  async generateKeyPair(serviceId: string): Promise<{ recipient: string; identity: string }> {
    const identityString = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identityString);

    this.registrations.set(serviceId, {
      recipient,
      identityString,
      approvedOps: [],
      approved: true, // Default to approved after generation
    });

    return { recipient, identity: identityString };
  }

  async getRecipient(serviceId: string): Promise<string | null> {
    const registration = this.registrations.get(serviceId);
    if (!registration) {
      return null;
    }
    return registration.recipient;
  }

  /**
   * Get the identity string for a service.
   * This is needed for decryption operations.
   */
  async getIdentity(serviceId: string): Promise<string | null> {
    const registration = this.registrations.get(serviceId);
    if (!registration) {
      return null;
    }
    return registration.identityString;
  }

  async isApproved(serviceId: string): Promise<boolean> {
    const registration = this.registrations.get(serviceId);
    if (!registration) {
      return false;
    }
    return registration.approved;
  }

  getApprovedOps(serviceId: string): string[] {
    const registration = this.registrations.get(serviceId);
    if (!registration) {
      return [];
    }
    return [...registration.approvedOps];
  }

  setApprovedOps(serviceId: string, ops: string[]): void {
    const registration = this.registrations.get(serviceId);
    if (registration) {
      registration.approvedOps = ops;
    }
  }

  async rotateKey(serviceId: string): Promise<{ recipient: string; identity: string }> {
    // Generate a new key pair (this will replace the existing one)
    return this.generateKeyPair(serviceId);
  }

  list(): ServiceRegistration[] {
    const result: ServiceRegistration[] = [];
    for (const [id, registration] of this.registrations) {
      result.push({
        id,
        recipient: registration.recipient,
        approvedOps: [...registration.approvedOps],
        approved: registration.approved,
      });
    }
    return result;
  }

  revoke(serviceId: string): void {
    this.registrations.delete(serviceId);
  }
}
