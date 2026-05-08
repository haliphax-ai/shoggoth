/**
 * Age encryption module for credential vault.
 * Uses the age-encryption library for X25519-based encryption.
 */

import * as age from "age-encryption";
import { readFileSync } from "node:fs";

export interface AgeIdentity {
  /** The raw identity string (AGE-SECRET-KEY-1...). */
  readonly identityString: string;
  /** The derived recipient/public key (age1...). */
  readonly recipient: string;
}

/**
 * Generate a new age X25519 identity (keypair).
 * Returns a Promise because the age-encryption library is async.
 */
export async function ageGenerateIdentity(): Promise<AgeIdentity> {
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
export async function ageLoadIdentity(filePath: string): Promise<AgeIdentity> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Identity file not found: ${filePath}`);
    }
    throw e;
  }

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
    const recipient = await age.identityToRecipient(trimmed);

    return {
      identityString: trimmed,
      recipient,
    };
  }

  throw new Error("No valid identity found in file");
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

  // Convert to base64 for armored format
  const base64Data = Buffer.from(encrypted).toString("base64");

  return `-----BEGIN AGE ENCRYPTED FILE-----\n${base64Data}\n-----END AGE ENCRYPTED FILE-----`;
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

  for (const line of lines) {
    if (line.startsWith("-----BEGIN AGE") || line.startsWith("-----END AGE")) {
      continue;
    }
    if (line.trim()) {
      bodyLines.push(line.trim());
    }
  }

  const bodyBase64 = bodyLines.join("");

  // Decode the body
  const encrypted = new Uint8Array(Buffer.from(bodyBase64, "base64"));

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
