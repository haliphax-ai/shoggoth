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

/** Allowed clock drift, in seconds, between token issuance and validation. */
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

// A base64url token is the encoding of an age ciphertext file, whose header
// alone spans several dozen bytes. Tokens shorter than this minimum cannot
// carry a valid ciphertext, so they are rejected before any decryption work.
const MIN_TOKEN_LENGTH = 32;

// The decrypter is stateless per identity once configured, so one instance per
// identity string is reused across validations instead of reallocating per call.
const decrypters = new Map<string, age.Decrypter>();

function getDecrypter(identityString: string): age.Decrypter {
  let decrypter = decrypters.get(identityString);
  if (!decrypter) {
    decrypter = new age.Decrypter();
    decrypter.addIdentity(identityString);
    decrypters.set(identityString, decrypter);
  }
  return decrypter;
}

export class TokenValidator {
  static async validate(
    token: string,
    identityString: string,
  ): Promise<ServiceTokenPayload | null> {
    try {
      // Shorter than any age ciphertext can be; reject it without decrypting.
      if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error("token shorter than the minimum length");
      }

      const ciphertext = Buffer.from(token, "base64url");

      const plaintext = await getDecrypter(identityString).decrypt(ciphertext, "text");

      const payload: ServiceTokenPayload = JSON.parse(plaintext);

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        return null;
      }

      // Tokens issued in the future are rejected; small clock drift between
      // the minter and this validator is tolerated.
      if (payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS) {
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
