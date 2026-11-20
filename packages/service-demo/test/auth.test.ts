import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as age from "age-encryption";
import { request } from "node:http";
import type { ServiceTokenPayload } from "@shoggoth/service-auth";

const PROVISION_SECRET = "test-provision-secret-xyz";

/** Mint a valid age-encrypted service token. */
async function mintToken(payload: ServiceTokenPayload, recipient: string): Promise<string> {
  const plaintext = JSON.stringify(payload);
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(plaintext);
  return Buffer.from(ciphertext).toString("base64url");
}

/** Simple HTTP request helper. */
function makeRequest(
  port: number,
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const headers: Record<string, string> = {
      ...options?.headers,
    };
    if (options?.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options?.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe("demo service auth integration", () => {
  let port: number;
  let serverProcess: ReturnType<typeof import("node:child_process").spawn> | undefined;
  let identity: string;
  let recipient: string;
  /** Recipient matching the identity currently stored by the service. */
  let storedRecipient: string;

  beforeAll(async () => {
    // Generate an age identity/recipient pair for token minting
    identity = await age.generateIdentity();
    recipient = await age.identityToRecipient(identity);
    storedRecipient = recipient;

    // Pick a random available port
    const net = await import("node:net");
    port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        srv.close(() => resolve(addr.port));
      });
    });

    // Start the demo server as a child process
    const { spawn } = await import("node:child_process");
    const { resolve: pathResolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const serverPath = pathResolve(fileURLToPath(import.meta.url), "../../src/server.ts");

    serverProcess = spawn("npx", ["tsx", serverPath], {
      env: {
        ...process.env,
        DEMO_SERVICE_PORT: String(port),
        DEMO_SERVICE_HOST: "127.0.0.1",
        DEMO_PROVISION_SECRET: PROVISION_SECRET,
      },
      stdio: "pipe",
    });

    // Wait for server to be ready: probe /health on event-loop ticks until
    // it answers 200. Vitest's hook timeout is the start-up failure guard.
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        makeRequest(port, "GET", "/health")
          .then((res) => {
            if (res.status === 200) resolve();
            else setImmediate(check);
          })
          .catch(() => setImmediate(check));
      };
      serverProcess!.on("error", reject);
      setImmediate(check);
    });
  });

  afterAll(async () => {
    if (serverProcess) {
      // The direct child's stdio pipes are inherited by the tsx grandchild,
      // so "close" never fires here; wait for "exit" of the npx wrapper
      // instead. Request graceful shutdown first, then warn and escalate to
      // SIGKILL if the server hangs so a stuck shutdown can't pass silently.
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          console.warn(
            "demo server did not shut down cleanly within 2s of SIGTERM; escalating to SIGKILL",
          );
          serverProcess!.kill("SIGKILL");
        }, 2_000);
        serverProcess!.on("exit", () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
        serverProcess!.kill("SIGTERM");
      });
    }
  });

  describe("POST /_shoggoth/identity", () => {
    it("stores the identity when provision secret matches", async () => {
      const res = await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": PROVISION_SECRET },
        body: { identity },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("rejects when provision secret is wrong", async () => {
      const res = await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": "wrong-secret" },
        body: { identity },
      });
      expect(res.status).toBe(403);
    });

    it("accepts rotation token when identity is already stored", async () => {
      // Generate a new identity for rotation
      const newIdentity = await age.generateIdentity();

      // Mint a valid token with the current identity to authorize rotation
      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "daemon", scope: "identity:rotate", iat: now, exp: now + 300 },
        recipient,
      );

      const res = await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { authorization: `Bearer ${token}` },
        body: { identity: newIdentity },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      storedRecipient = await age.identityToRecipient(newIdentity);
    });
  });

  describe("GET /api/get_message", () => {
    it("returns 401 without auth header", async () => {
      const res = await makeRequest(port, "GET", "/api/get_message");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await makeRequest(port, "GET", "/api/get_message", {
        headers: { authorization: "Bearer invalid-token-garbage" },
      });
      expect(res.status).toBe(401);
    });

    it("succeeds with valid minted token", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
        storedRecipient,
      );

      const res = await makeRequest(port, "GET", "/api/get_message", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect((res.body as { message: string }).message).toBeDefined();
    });
  });

  describe("POST /api/set_message", () => {
    it("succeeds with valid minted token", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
        storedRecipient,
      );

      const res = await makeRequest(port, "POST", "/api/set_message", {
        headers: { authorization: `Bearer ${token}` },
        body: { message: "Updated via auth test" },
      });
      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean; message: string }).ok).toBe(true);
      expect((res.body as { ok: boolean; message: string }).message).toBe("Updated via auth test");
    });
  });

  describe("request body size limit", () => {
    /** Oversized payload: 1 MiB limit + extra margin to clear it on any chunking. */
    const OVER_LIMIT_BODY_BYTES = 1024 * 1024 + 1024;

    it("rejects oversized request bodies with 413 and the server stays healthy", async () => {
      const res = await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": PROVISION_SECRET },
        body: { identity: "x".repeat(OVER_LIMIT_BODY_BYTES) },
      });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: "request body too large" });

      const health = await makeRequest(port, "GET", "/health");
      expect(health.status).toBe(200);
    });

    it("accepts normal-size request bodies", async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
        storedRecipient,
      );

      const res = await makeRequest(port, "POST", "/api/set_message", {
        headers: { authorization: `Bearer ${token}` },
        body: { message: "within the body size limit" },
      });
      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean }).ok).toBe(true);
    });
  });
});
