/**
 * FIFO Credential Proxy - Creates short-lived named pipes for credential delivery.
 */

import { mkdir, chmod, chown, open, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

const VAULT_DIR = "/tmp/.vault";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Create a FIFO (named pipe) and return its path. Spawns a background
 * task that writes the secret on first reader open, then unlinks.
 *
 * @param secret - The plaintext to write.
 * @param uid - Owner UID for the FIFO.
 * @param gid - Owner GID for the FIFO.
 * @param timeoutMs - Auto-cleanup timeout (default 30000).
 * @returns Absolute path to the FIFO.
 */
export async function createSecretFifo(
  secret: string,
  uid: number,
  gid: number,
  timeoutMs?: number,
): Promise<string> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Ensure vault directory exists
  if (!existsSync(VAULT_DIR)) {
    await mkdir(VAULT_DIR, { mode: 0o711, recursive: true });
  }

  // Generate random hex filename
  const filename = randomBytes(16).toString("hex");
  const fifoPath = join(VAULT_DIR, filename);

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

  // Set ownership (best-effort — requires root in production)
  let chownSucceeded = false;
  try {
    await chown(fifoPath, uid, gid);
    chownSucceeded = true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
  }
  // If chown succeeded, lock to owner only; otherwise allow group/other read
  // so the agent (different UID) can still consume the FIFO.
  await chmod(fifoPath, chownSucceeded ? 0o600 : 0o644);

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
