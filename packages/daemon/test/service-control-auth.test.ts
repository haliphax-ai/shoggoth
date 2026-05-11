/**
 * Service Control Plane Auth Tests - Authentication and authorization for service control plane access
 *
 * Phase 5: Scoped Control Plane Access for Services
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ServiceKeyStore } from "../src/service-key-store";
import { ServiceControlPlaneAuthImpl } from "../src/control/service-auth";
import { TokenMinter } from "../src/service-auth";

describe("ServiceControlPlaneAuth", () => {
  let keyStore: ServiceKeyStore;
  let auth: ServiceControlPlaneAuthImpl;

  beforeEach(() => {
    keyStore = new ServiceKeyStore("/tmp/test-secrets");
    auth = new ServiceControlPlaneAuthImpl(keyStore);
  });

  describe("authenticate", () => {
    it("returns true for valid service with correct proof", async () => {
      await keyStore.generateKeyPair("valid-service");
      const minter = new TokenMinter(keyStore);
      const token = await minter.mint("agent-123", "valid-service");
      const result = await auth.authenticate("valid-service", token);
      expect(result).toBe(true);
    });

    it("returns false for unknown service", async () => {
      const result = await auth.authenticate("unknown-service", "any-proof");
      expect(result).toBe(false);
    });

    it("returns false for revoked service", async () => {
      await keyStore.generateKeyPair("revoked-service");
      keyStore.revoke("revoked-service");
      const result = await auth.authenticate("revoked-service", "any-proof");
      expect(result).toBe(false);
    });
  });

  describe("isOperationAllowed", () => {
    it("returns true for approved op", async () => {
      await keyStore.generateKeyPair("test-service");
      keyStore.setApprovedOps("test-service", ["read", "write"]);
      const result = auth.isOperationAllowed("test-service", "read");
      expect(result).toBe(true);
    });

    it("returns false for unapproved op", async () => {
      await keyStore.generateKeyPair("test-service");
      keyStore.setApprovedOps("test-service", ["read"]);
      const result = auth.isOperationAllowed("test-service", "unapproved-op");
      expect(result).toBe(false);
    });

    it("returns false for revoked service", () => {
      const result = auth.isOperationAllowed("revoked-service", "read");
      expect(result).toBe(false);
    });
  });
});
