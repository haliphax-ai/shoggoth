/**
 * FIFO Credential Proxy - Creates short-lived named pipes for credential delivery.
 */

import { mkdir, chmod, open, unlink } from "node:fs/promises";

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

export const DEFAULT_VAULT_DIR = "/tmp/.vault";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Create a FIFO (named pipe) and return its path. Spawns a background
 * task that writes the secret on first reader open, then unlinks.
 *
 * @param secret - The plaintext to write.
 * @param uid - Owner UID for the FIFO (unused, kept for API compat).
 * @param gid - Owner GID for the FIFO (unused, kept for API compat).
 * @param timeoutMs - Auto-cleanup timeout (default 30000).
 * @param dir - Directory for the FIFO (default /tmp/.vault).
 * @returns Absolute path to the FIFO.
 */
export async function createSecretFifo(
  secret: string,
  uid: number,
  gid: number,
  timeoutMs?: number,
  dir?: string,
): Promise<string> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vaultDir = dir ?? DEFAULT_VAULT_DIR;

  // Ensure vault directory exists with correct permissions
  await mkdir(vaultDir, { mode: 0o711, recursive: true });
  await chmod(vaultDir, 0o711);

  // Generate random hex filename
  const filename = randomBytes(16).toString("hex");
  const fifoPath = join(vaultDir, filename);

  // Create FIFO using mkfifo
  await new Promise<void>((resolve, reject) => {
    const mkfifo = spawn("mkfifo", [fifoPath]);
    mkfifo.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mkfifo exited with code ${code}`));
      }
    });
    mkfifo.on("error", reject);
  });

  // Set permissions so any local user (including the agent) can read the FIFO.
  await chmod(fifoPath, 0o644);

  // Set up timeout to unlink if no reader connects
  const timeoutId = setTimeout(async () => {
    try {
      await unlink(fifoPath);
    } catch {
      // Ignore if already unlinked
    }
  }, timeout);

  // Spawn background task to write secret when reader opens
  (async () => {
    try {
      // Open FIFO for writing - this blocks until a reader opens it
      const fd = await open(fifoPath, "w");
      try {
        // Write the secret
        await fd.writeFile(secret, "utf8");
      } finally {
        // Close the file
        await fd.close();
      }
      // Unlink the FIFO after writing
      await unlink(fifoPath);
    } catch {
      // If writer fails (e.g., no reader), clean up
      try {
        await unlink(fifoPath);
      } catch {
        // Ignore
      }
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  return fifoPath;
}
