/**
 * Service Auth - Token minting and validation for per-service identities
 *
 * Phase 2: Auth - Per-Service Age Identities
 */

import * as age from "age-encryption";
import { ServiceKeyStore } from "./service-key-store";
import { ageEncrypt } from "./vault/age-crypto";

export interface ServiceTokenPayload {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  session?: string;
}

export class TokenMinter {
  private keyStore: ServiceKeyStore;

  constructor(keyStore: ServiceKeyStore) {
    this.keyStore = keyStore;
  }

  async mint(agentId: string, serviceId: string, sessionUrn?: string): Promise<string> {
    // Get the recipient for this service
    const recipient = await this.keyStore.getRecipient(serviceId);
    if (!recipient) {
      throw new Error(`Service ${serviceId} not found in key store`);
    }

    // Build the payload
    const now = Math.floor(Date.now() / 1000);
    const payload: ServiceTokenPayload = {
      sub: agentId,
      scope: serviceId,
      iat: now,
      exp: now + 300, // 5 minutes
      session: sessionUrn,
    };

    // Serialize to JSON
    const jsonPayload = JSON.stringify(payload);

    // Encrypt with age to the recipient - use the working ageEncrypt function
    const encrypted = await ageEncrypt(jsonPayload, recipient);

    // Strip the armor headers and convert to base64url
    const lines = encrypted.trim().split("\n");
    const bodyLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-----BEGIN AGE") || line.startsWith("-----END AGE")) {
        continue;
      }
      if (line.trim()) {
        bodyLines.push(line.trim());
      }
    }
    const base64 = bodyLines.join("");
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    return base64url;
  }
}

export class TokenValidator {
  /**
   * Validate a token and return the payload if valid.
   * @param token - The base64url-encoded encrypted token
   * @param identityString - The age identity (private key) to decrypt with
   */
  static async validate(
    token: string,
    identityString: string,
  ): Promise<ServiceTokenPayload | null> {
    try {
      // Decode base64url to base64
      let base64 = token.replace(/-/g, "+").replace(/_/g, "/");
      // Add padding if needed
      while (base64.length % 4) {
        base64 += "=";
      }

      // Decrypt with the identity
      const decrypter = new age.Decrypter();
      decrypter.addIdentity(identityString);

      // Decode the base64 body
      const bodyBase64 = base64.replace(/(\r\n|\r|\n)/g, "");
      const encrypted = new Uint8Array(Buffer.from(bodyBase64, "base64"));

      const decrypted = await decrypter.decrypt(encrypted);

      // Convert Uint8Array to string
      const jsonPayload =
        decrypted instanceof Uint8Array ? new TextDecoder().decode(decrypted) : String(decrypted);

      // Parse JSON
      const payload: ServiceTokenPayload = JSON.parse(jsonPayload);

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return null;
      }

      return payload;
    } catch {
      // Decryption failed or token invalid
      return null;
    }
  }
}
