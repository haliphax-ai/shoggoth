import assert from "node:assert";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { describe, it } from "vitest";
import {
  readPeerCredFromSocket,
  ERR_PEERCRED_NOT_IMPLEMENTED,
  ERR_PEERCRED_NO_FD,
} from "../src/peercred";

describe("SO_PEERCRED", () => {
  it("throws ERR_PEERCRED_NO_FD when socket has no OS fd", () => {
    const sock = new Socket();
    try {
      assert.throws(
        () => readPeerCredFromSocket(sock),
        (e: unknown) =>
          e instanceof Error && (e as NodeJS.ErrnoException).code === ERR_PEERCRED_NO_FD,
      );
    } finally {
      sock.destroy();
    }
  });

  it("non-Linux: throws ERR_PEERCRED_NOT_IMPLEMENTED for a connected TCP socket (stub native)", async () => {
    if (process.platform === "linux") return;

    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr === null || typeof addr === "string") {
          srv.close();
          reject(new Error("expected server address"));
          return;
        }
        const client = createConnection({ port: addr.port, host: "127.0.0.1" }, () => {
          srv.once("connection", (peer) => {
            try {
              assert.throws(
                () => readPeerCredFromSocket(peer),
                (e: unknown) =>
                  e instanceof Error &&
                  (e as NodeJS.ErrnoException).code === ERR_PEERCRED_NOT_IMPLEMENTED,
              );
            } finally {
              peer.destroy();
              client.destroy();
              srv.close(() => resolve());
            }
          });
        });
        client.on("error", reject);
      });
      srv.on("error", reject);
    });
  });

  it("Linux: reads peer uid/gid/pid on Unix domain stream socket", async () => {
    if (process.platform !== "linux") return;

    const path = join(tmpdir(), `shoggoth-peercred-${Date.now()}-${process.pid}.sock`);
    await unlink(path).catch(() => {});

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      const onErr = (e: Error) => {
        server.close();
        reject(e);
      };
      let client: ReturnType<typeof createConnection> | undefined;
      server.once("connection", (srvSock) => {
        let testErr: unknown;
        try {
          const cred = readPeerCredFromSocket(srvSock);
          assert.strictEqual(cred.uid, process.getuid());
          assert.strictEqual(cred.gid, process.getgid());
          assert.ok(Number.isFinite(cred.pid) && cred.pid > 0);
        } catch (e) {
          testErr = e;
        } finally {
          srvSock.end();
          client?.end();
          server.close(() => {
            unlink(path)
              .catch(() => {})
              .then(() => {
                if (testErr) reject(testErr as Error);
                else resolve();
              });
          });
        }
      });
      server.on("error", onErr);
      server.listen(path, () => {
        client = createConnection(path);
        client.on("error", onErr);
      });
    });
  });
});
