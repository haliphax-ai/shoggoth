import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ageGenerateIdentity,
  ageLoadIdentity,
  ageEncrypt,
  ageDecrypt,
} from "../../src/vault/age-crypto.js";

describe("age-crypto", () => {
  describe("ageGenerateIdentity", () => {
    it("generates a valid AgeIdentity with proper prefixes", async () => {
      const identity = await ageGenerateIdentity();

      expect(identity).toBeDefined();
      expect(identity.identityString).toMatch(/^AGE-SECRET-KEY-1/);
      expect(identity.recipient).toMatch(/^age1/);
    });

    it("generates unique identities each time", async () => {
      const identity1 = await ageGenerateIdentity();
      const identity2 = await ageGenerateIdentity();

      expect(identity1.identityString).not.toBe(identity2.identityString);
      expect(identity1.recipient).not.toBe(identity2.recipient);
    });

    it("recipient is derived from identity string", async () => {
      const identity = await ageGenerateIdentity();

      // The recipient should be different from the identity string
      expect(identity.identityString).not.toBe(identity.recipient);
      expect(identity.identityString.startsWith("AGE-SECRET-KEY-1")).toBe(true);
      expect(identity.recipient.startsWith("age1")).toBe(true);
    });
  });

  describe("ageEncrypt and ageDecrypt", () => {
    it("round-trip produces original plaintext", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Hello, secure world!";

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      const decrypted = await ageDecrypt(ciphertext, identity);

      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random nonce)", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Same message";

      const ciphertext1 = await ageEncrypt(plaintext, identity.recipient);
      const ciphertext2 = await ageEncrypt(plaintext, identity.recipient);

      expect(ciphertext1).not.toBe(ciphertext2);
    });

    it("ciphertext is armored (contains age header)", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Test message";

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);

      expect(ciphertext).toContain("-----BEGIN AGE");
      expect(ciphertext).toContain("-----END AGE");
    });

    it("can encrypt with recipient without needing identity", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Test for encryption only";

      // Should be able to encrypt using just the recipient
      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      expect(ciphertext).toBeDefined();
      expect(ciphertext.length).toBeGreaterThan(0);
    });
  });

  describe("ageLoadIdentity", () => {
    let tempFile: string;

    beforeEach(() => {
      tempFile = join(tmpdir(), `shoggoth-age-test-${process.pid}-${Date.now()}.key`);
    });

    afterEach(() => {
      try {
        unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
    });

    it("loads identity from file", async () => {
      const expectedIdentity = await ageGenerateIdentity();
      writeFileSync(tempFile, expectedIdentity.identityString, "utf8");

      const loaded = await ageLoadIdentity(tempFile);

      expect(loaded.identityString).toBe(expectedIdentity.identityString);
      expect(loaded.recipient).toBe(expectedIdentity.recipient);
    });

    it("ignores comments and blank lines", async () => {
      const identity = await ageGenerateIdentity();
      const content = `# This is a comment
# Another comment

${identity.identityString}

# Trailing comment
`;
      writeFileSync(tempFile, content, "utf8");

      const loaded = await ageLoadIdentity(tempFile);

      expect(loaded.identityString).toBe(identity.identityString);
    });

    it("throws error when file does not exist", async () => {
      const nonExistentPath = join(tmpdir(), `non-existent-${Date.now()}.key`);

      await expect(ageLoadIdentity(nonExistentPath)).rejects.toThrow();
    });

    it("throws error for invalid identity format", async () => {
      writeFileSync(tempFile, "INVALID-KEY-FORMAT", "utf8");

      await expect(ageLoadIdentity(tempFile)).rejects.toThrow();
    });
  });

  describe("error cases", () => {
    it("fails to decrypt with wrong identity", async () => {
      const identity1 = await ageGenerateIdentity();
      const identity2 = await ageGenerateIdentity();
      const plaintext = "Secret message";

      const ciphertext = await ageEncrypt(plaintext, identity1.recipient);

      await expect(ageDecrypt(ciphertext, identity2)).rejects.toThrow();
    });

    it("fails to decrypt corrupted ciphertext", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Original message";

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      // Corrupt the base64 body (not just the footer)
      const lines = ciphertext.split("\n");
      // lines[0] = header, lines[1] = base64 body, lines[2] = footer
      const body = lines[1];
      const corruptedBody = body.slice(0, 10) + "ZZZZZZZZZZZZZZ" + body.slice(24);
      const corrupted = lines[0] + "\n" + corruptedBody + "\n" + lines[2];

      await expect(ageDecrypt(corrupted, identity)).rejects.toThrow();
    });

    it("fails to encrypt with invalid recipient", async () => {
      const plaintext = "Test message";

      await expect(ageEncrypt(plaintext, "invalid-recipient")).rejects.toThrow();
    });

    it("fails to decrypt with tampered ciphertext", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Original text";

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      // Swap characters in the base64 body to tamper
      const lines = ciphertext.split("\n");
      if (lines.length > 2) {
        // Tamper with the base64 body line
        const bodyLine = lines[1];
        const tampered =
          lines[0] + "\n" + bodyLine.slice(0, 10) + "AAAA" + bodyLine.slice(14) + "\n" + lines[2];

        await expect(ageDecrypt(tampered, identity)).rejects.toThrow();
      }
    });

    it("fails to encrypt empty plaintext", async () => {
      const identity = await ageGenerateIdentity();

      await expect(ageEncrypt("", identity.recipient)).rejects.toThrow();
    });
  });

  describe("cross-identity operations", () => {
    it("identity generated can decrypt what it encrypts", async () => {
      const identity = await ageGenerateIdentity();
      const plaintext = "Cross-identity test";

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      const decrypted = await ageDecrypt(ciphertext, identity);

      expect(decrypted).toBe(plaintext);
    });

    it("different identities cannot decrypt each other's messages", async () => {
      const alice = await ageGenerateIdentity();
      const bob = await ageGenerateIdentity();

      const messageForBob = "Message for Bob";
      const ciphertext = await ageEncrypt(messageForBob, bob.recipient);

      // Alice should not be able to decrypt Bob's message
      await expect(ageDecrypt(ciphertext, alice)).rejects.toThrow();
    });
  });
});
