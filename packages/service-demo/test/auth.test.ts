import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as age from "age-encryption";
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
    import("node:http").then(({ request }) => {
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
  });
}

describe("demo service auth integration", () => {
  let port: number;
  let serverProcess: ReturnType<typeof import("node:child_process").spawn> | undefined;
  let identity: string;
  let recipient: string;

  beforeAll(async () => {
    // Generate an age identity/recipient pair for token minting
    identity = await age.generateIdentity();
    recipient = await age.identityToRecipient(identity);

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

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server start timeout")), 10_000);
      const check = () => {
        makeRequest(port, "GET", "/health")
          .then((res) => {
            if (res.status === 200) {
              clearTimeout(timeout);
              resolve();
            } else {
              setTimeout(check, 50);
            }
          })
          .catch(() => setTimeout(check, 50));
      };
      serverProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      setTimeout(check, 100);
    });
  });

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        serverProcess!.on("close", () => resolve());
        setTimeout(resolve, 2000);
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
      // First, provision the identity
      await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": PROVISION_SECRET },
        body: { identity },
      });

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
      // Ensure identity is provisioned
      await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": PROVISION_SECRET },
        body: { identity },
      });

      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
        recipient,
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
      // Ensure identity is provisioned
      await makeRequest(port, "POST", "/_shoggoth/identity", {
        headers: { "x-provision-secret": PROVISION_SECRET },
        body: { identity },
      });

      const now = Math.floor(Date.now() / 1000);
      const token = await mintToken(
        { sub: "agent-1", scope: "service", iat: now, exp: now + 300 },
        recipient,
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
});
