import * as age from "age-encryption";
import { getLogger } from "@shoggoth/shared";

const log = getLogger("service-auth");

export interface ServiceTokenPayload {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  session?: string;
}

export class TokenValidator {
  static async validate(
    token: string,
    identityString: string,
  ): Promise<ServiceTokenPayload | null> {
    try {
      const ciphertext = Buffer.from(token, "base64url");

      const decrypter = new age.Decrypter();
      decrypter.addIdentity(identityString);
      const plaintext = await decrypter.decrypt(ciphertext, "text");

      const payload: ServiceTokenPayload = JSON.parse(plaintext);

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        return null;
      }

      return payload;
    } catch (err) {
      // Invalid/malformed tokens are an expected path here, so a debug record
      // is enough — callers treat a null result as "reject the request".
      const msg = err instanceof Error ? err.message : String(err);
      log.debug("token_validate_failed", { error: msg });
      return null;
    }
  }
}
