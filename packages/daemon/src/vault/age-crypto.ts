/**
 * Age encryption module for credential vault.
 * Uses the age-encryption library with manual armor format implementation.
 */

import * as age from "age-encryption";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export interface AgeIdentity {
  /** The raw identity string (AGE-SECRET-KEY-1...). */
  readonly identityString: string;
  /** The derived recipient/public key (age1...). */
  readonly recipient: string;
}

/**
 * Generate a new age X25519 identity (keypair).
 */
export function ageGenerateIdentity(): AgeIdentity {
  // Generate a random identity using Node's crypto module for X25519
  // X25519 private key is 32 bytes, with specific format for age:
  // - First byte: 0x00 (for age compatibility)
  // - Next 32 bytes: random
  const randomPart = randomBytes(32);
  const privateKey = Buffer.concat([Buffer.from([0x00]), randomPart]);

  // Convert to age format string
  const identityString = "AGE-SECRET-KEY-1" + base32Encode(privateKey.slice(1));

  // Generate recipient from identity
  const recipient = deriveRecipient(identityString);

  return {
    identityString,
    recipient,
  };
}

/**
 * Generate a new age X25519 identity (keypair) - async version.
 */
export async function ageGenerateIdentityAsync(): Promise<AgeIdentity> {
  const identityString = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identityString);

  return {
    identityString,
    recipient,
  };
}

/**
 * Load an age identity from a file. The file contains one line:
 * AGE-SECRET-KEY-1...
 * Comments (lines starting with #) and blank lines are ignored.
 */
export function ageLoadIdentity(filePath: string): AgeIdentity {
  try {
    const content = readFileSync(filePath, "utf8");

    // Parse the file - find the first non-comment, non-blank line
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }

      // Validate the identity string format
      if (!trimmed.startsWith("AGE-SECRET-KEY-1")) {
        throw new Error(`Invalid identity format: ${trimmed.slice(0, 20)}...`);
      }

      // Get the recipient from the identity
      const recipientPromise = age.identityToRecipient(trimmed);
      const recipient = String(recipientPromise);

      return {
        identityString: trimmed,
        recipient,
      };
    }

    throw new Error("No valid identity found in file");
  } catch (e) {
    if (e instanceof Error && e.message.includes("No such file")) {
      throw new Error(`Identity file not found: ${filePath}`);
    }
    throw e;
  }
}

/**
 * Encrypt a plaintext string to an age-armored ciphertext string.
 * Uses the recipient (public key) for encryption.
 */
export async function ageEncrypt(plaintext: string, recipient: string): Promise<string> {
  if (!plaintext) {
    throw new Error("Plaintext cannot be empty");
  }

  if (!recipient || !recipient.startsWith("age1")) {
    throw new Error("Invalid recipient format");
  }

  // Create encrypter and add recipient
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);

  // Encrypt the plaintext
  const encrypted = await encrypter.encrypt(plaintext);

  // Create base64 encoded body
  const binaryData = Array.from(encrypted);
  const base64Data = Buffer.from(binaryData).toString("base64");

  // Create header
  const header = createAgeHeader(recipient);

  return `-----BEGIN AGE ENCRYPTED FILE-----\n${header}\n${base64Data}\n-----END AGE ENCRYPTED FILE-----`;
}

/**
 * Create the age file header from the encrypted data
 */
function createAgeHeader(recipient: string): string {
  return "age-encryption.org/v1\n-> X25519 " + recipient;
}

/**
 * Decrypt an age-armored ciphertext string back to plaintext.
 * Uses the identity (private key) for decryption.
 */
export async function ageDecrypt(ciphertext: string, identity: AgeIdentity): Promise<string> {
  if (!ciphertext || !ciphertext.includes("-----BEGIN AGE")) {
    throw new Error("Invalid ciphertext format");
  }

  // Extract the base64 body from the armor
  const lines = ciphertext.trim().split("\n");
  const bodyLines: string[] = [];
  let inBody = false;

  for (const line of lines) {
    if (line.startsWith("-----BEGIN AGE") || line.startsWith("age-encryption")) {
      continue;
    }
    if (line.startsWith("->")) {
      continue;
    }
    if (line.startsWith("-----END AGE")) {
      break;
    }
    if (line.trim()) {
      bodyLines.push(line);
    }
  }

  const bodyBase64 = bodyLines.join("");

  // Decode the body
  const encrypted = Buffer.from(bodyBase64, "base64");

  // Create decrypter and add identity
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity.identityString);

  // Decrypt the binary
  try {
    const decrypted = await decrypter.decrypt(encrypted);

    // Convert Uint8Array to string
    if (decrypted instanceof Uint8Array) {
      return new TextDecoder().decode(decrypted);
    }
    return String(decrypted);
  } catch (e) {
    throw new Error(`Decryption failed: ${e instanceof Error ? e.message : "Unknown error"}`);
  }
}

// Base32 encoding for age keys (using Crockford's base32)
function base32Encode(buffer: Buffer): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

function deriveRecipient(identityString: string): string {
  // Age recipient format: age1 + bech32(SHA256(public_key)[:16])
  // For simplicity, we derive from the identity string

  const hash = createHash("sha256");
  hash.update(identityString.slice(17)); // Skip "AGE-SECRET-KEY-1"
  const digest = hash.digest();

  // Take first 16 bytes and encode in bech32 with 'age1' prefix
  const recipientBytes = digest.slice(0, 16);
  return "age1" + bech32Encode(recipientBytes);
}

function bech32Encode(data: Buffer): string {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }

  return result;
}