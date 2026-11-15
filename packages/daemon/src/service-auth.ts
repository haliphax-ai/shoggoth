import * as age from "age-encryption";
import type { ServiceKeyStore } from "./service-key-store.js";
import type { ServiceTokenPayload } from "@shoggoth/service-auth";

export class TokenMinter {
  constructor(private keyStore: ServiceKeyStore) {}

  async mint(agentId: string, serviceId: string, sessionUrn?: string): Promise<string> {
    const recipient = this.keyStore.getRecipient(serviceId);
    if (!recipient) {
      throw new Error(`No recipient found for service: ${serviceId}`);
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 300;

    const payload: ServiceTokenPayload = {
      sub: agentId,
      scope: serviceId,
      iat,
      exp,
    };

    if (sessionUrn !== undefined) {
      payload.session = sessionUrn;
    }

    const plaintext = JSON.stringify(payload);

    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    const ciphertext = await encrypter.encrypt(plaintext);

    return Buffer.from(ciphertext).toString("base64url");
  }
}
