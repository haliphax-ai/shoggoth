/**
 * FIFO Credential Proxy - Creates short-lived named pipes for credential delivery.
 */

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
  throw new Error("not implemented");
}