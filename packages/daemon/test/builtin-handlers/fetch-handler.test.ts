import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { BuiltinToolContext } from "../../src/sessions/builtin-tool-registry";
import { BuiltinToolRegistry } from "../../src/sessions/builtin-tool-registry";
import { register } from "../../src/sessions/builtin-handlers/fetch-handler";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const certPath = join(fixturesDir, "localhost-cert.pem");
const keyPath = join(fixturesDir, "localhost-key.pem");

function makeCtx(fetch: ShoggothConfig["fetch"]): BuiltinToolContext {
  const config = { ...defaultConfig("/tmp/cfg"), fetch } as ShoggothConfig;
  return {
    sessionId: "agent:test:discord:channel:123",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    config,
    env: process.env,
    workspacePath: "/tmp",
    creds: { uid: 1000, gid: 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    memoryConfig: config.memory,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

describe("fetch-handler — custom CA bundle over TLS", () => {
  let server: https.Server;
  let origin: string;

  beforeAll(async () => {
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    server = https.createServer({ key, cert }, (req, res) => {
      const respond = () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("secure hello");
      };
      // "?slow" holds the response with no timer: the client's own abort
      // timeout is the gate, so nothing is ever written on this route.
      if (req.url?.includes("slow")) return;
      respond();
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const { port } = server.address() as AddressInfo;
    origin = `https://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    // Keep-alive sockets from the cached dispatchers would delay close().
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("fails TLS verification against the self-signed server without fetch.caBundle", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: origin },
      makeCtx({ allowPrivateIps: true }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toMatch(/^Fetch failed/);
    // The failure must be certificate verification, not a generic error.
    expect(parsed.error).toMatch(/certificate|self-signed/i);
  });

  it("succeeds when fetch.caBundle points at the server certificate", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: origin },
      makeCtx({ allowPrivateIps: true, caBundle: certPath }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe(200);
    expect(parsed.body).toContain("secure hello");
    expect(parsed.headers["content-type"]).toContain("text/plain");
    expect(parsed.truncated).toBe(false);
  });

  it("applies the same timeout/redirect semantics with a bundle configured", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}?slow`, timeoutMs: 50 },
      makeCtx({ allowPrivateIps: true, caBundle: certPath }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.error).toMatch(/timed out after 50ms/);
  });

  it("returns an error when the configured bundle cannot be read", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: origin },
      makeCtx({ allowPrivateIps: true, caBundle: join(fixturesDir, "does-not-exist.pem") }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.error).toMatch(/Failed to load CA bundle/);
    expect(parsed.error).toMatch(/ENOENT|no such file/i);
  });

  it("returns an error when the configured bundle is not valid PEM", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: origin },
      makeCtx({ allowPrivateIps: true, caBundle: join(fixturesDir, "not-a-bundle.txt") }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.error).toMatch(/Failed to load CA bundle/);
  });
});

describe("fetch-handler — redirect following", () => {
  let server: http.Server;
  let origin: string;
  const methodsSeen: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      methodsSeen[req.url ?? ""] = req.method;
      const port = (server.address() as AddressInfo).port;
      switch (req.url) {
        case "/redirect-once":
          res.writeHead(302, { location: "/final" });
          res.end();
          return;
        case "/redirect-chain":
          res.writeHead(302, { location: "/redirect-once" });
          res.end();
          return;
        case "/redirect-303":
          res.writeHead(303, { location: "/final-303" });
          res.end();
          return;
        case "/redirect-307":
          res.writeHead(307, { location: "/final-307" });
          res.end();
          return;
        case "/redirect-internal":
          res.writeHead(302, { location: `http://localhost:${port}/final` });
          res.end();
          return;
        case "/final":
        case "/final-303":
        case "/final-307":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("landed");
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("follows a single redirect by default and reports the chain", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-once` },
      makeCtx({ allowPrivateIps: true }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe(200);
    expect(parsed.body).toContain("landed");
    expect(parsed.redirects).toEqual([
      { url: `${origin}/redirect-once`, status: 302, location: `${origin}/final` },
    ]);
  });

  it("does not follow redirects when followRedirects is false", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-once`, followRedirects: false },
      makeCtx({ allowPrivateIps: true }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.status).toBe(302);
    expect(parsed.headers.location).toBe("/final");
    expect(parsed.redirects).toBeUndefined();
  });

  it("caps following at fetch.maxRedirects and returns the last response", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-chain` },
      makeCtx({ allowPrivateIps: true, maxRedirects: 1 }),
    );
    const parsed = JSON.parse(result.resultJson);

    // One hop followed (/redirect-chain -> /redirect-once), then the cap
    // stops on the second 302, which is returned as-is with the chain.
    expect(parsed.status).toBe(302);
    expect(parsed.redirects).toEqual([
      { url: `${origin}/redirect-chain`, status: 302, location: `${origin}/redirect-once` },
    ]);
  });

  it("re-checks redirect targets against the private-IP block", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-internal` },
      makeCtx({ allowPrivateIps: false, privateIpAllowlist: ["127.0.0.1"] }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toMatch(/Blocked: localhost/);
  });

  it("downgrades POST to GET when following a 303", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-303`, method: "POST", body: { hello: "world" } },
      makeCtx({ allowPrivateIps: true }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.status).toBe(200);
    expect(methodsSeen["/final-303"]).toBe("GET");
  });

  it("preserves the POST method when following a 307", async () => {
    const registry = new BuiltinToolRegistry();
    register(registry);

    const result = await registry.execute(
      "fetch",
      { url: `${origin}/redirect-307`, method: "POST", body: { hello: "world" } },
      makeCtx({ allowPrivateIps: true }),
    );
    const parsed = JSON.parse(result.resultJson);

    expect(parsed.status).toBe(200);
    expect(methodsSeen["/final-307"]).toBe("POST");
  });
});
