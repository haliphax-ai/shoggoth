/**
 * SO_PEERCRED for Unix domain sockets (Linux).
 * Linux: N-API addon calls getsockopt(SO_PEERCRED). Other platforms: native stub throws
 * ERR_PEERCRED_NOT_IMPLEMENTED when invoked (use operator_token auth or inject readPeerCred).
 */

import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeerCredentials } from "./principal";

export const ERR_PEERCRED_NOT_IMPLEMENTED = "ERR_PEERCRED_NOT_IMPLEMENTED";
/** Accepted Unix stream socket has no OS file descriptor yet (e.g. not connected). */
export const ERR_PEERCRED_NO_FD = "ERR_PEERCRED_NO_FD";

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type NativeReadPeerCred = (fd: number) => { pid: number; uid: number; gid: number };

function loadNative(): NativeReadPeerCred | null {
  try {
    const mod = require("node-gyp-build")(pkgRoot) as { readPeerCred: NativeReadPeerCred };
    return typeof mod.readPeerCred === "function" ? mod.readPeerCred : null;
  } catch {
    return null;
  }
}

const nativeReadPeerCred: NativeReadPeerCred | null = loadNative();

function peerCredNotImplemented(message: string): never {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = ERR_PEERCRED_NOT_IMPLEMENTED;
  throw err;
}

function peerCredNoFd(message: string): never {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = ERR_PEERCRED_NO_FD;
  throw err;
}

/**
 * Returns the OS-level socket fd for a connected Node `net.Socket` (Pipe/TCP handle).
 * Not part of the stable Node API; required for SO_PEERCRED.
 */
export function unixSocketFdForTests(socket: Socket): number | undefined {
  const handle = socket as unknown as { _handle?: { fd?: number } };
  const fd = handle._handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : undefined;
}

/**
 * Read peer credentials on a Linux Unix-domain stream socket after accept/connect.
 * @throws {Error} code ERR_PEERCRED_NOT_IMPLEMENTED — non-Linux stub, or native addon missing
 * @throws {Error} code ERR_PEERCRED_NO_FD — socket has no fd (not connected)
 * @throws {Error} code ERR_PEERCRED_SYSCALL — getsockopt failed (errno message in .message)
 */
export function readPeerCredFromSocket(socket: Socket): PeerCredentials {
  const fd = unixSocketFdForTests(socket);
  if (fd === undefined) {
    peerCredNoFd(
      "SO_PEERCRED: socket has no OS fd (connect or accept before reading peer credentials)",
    );
  }

  if (!nativeReadPeerCred) {
    peerCredNotImplemented(
      "SO_PEERCRED: native addon failed to load — run npm install in @shoggoth/authn (node-gyp-build)",
    );
  }

  const { pid, uid, gid } = nativeReadPeerCred(fd);
  return { pid, uid, gid };
}
