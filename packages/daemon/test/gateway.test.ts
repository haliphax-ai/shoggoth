import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { ServiceGateway, GatewayOptions } from "../src/gateway";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";
import { ServiceKeyStore } from "../src/service-key-store";
import { TokenMinter } from "../src/service-auth";

/**
 * Helper function to create a mock ServiceEntry for testing.
 */
function createMockEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: "test-service",
    label: "Test Service",
    url: "http://127.0.0.1:3000",
    wsUrl: "ws://127.0.0.1:3000",
    healthy: true,
    capabilities: ["test-capability"],
    expose: "gateway",
    manifest: null,
    registeredTools: [],
    ...overrides,
  };
}

/**
 * Helper to make HTTP requests with timeout.
 */
function httpRequest(
  options: http.RequestOptions | string,
  body?: string,
  timeout = 5000,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

describe("ServiceGateway", () => {
  let registry: ServiceRegistry;
  let gateway: ServiceGateway;
  let options: GatewayOptions;
  const testPort = 18443;

  beforeEach(() => {
    registry = new ServiceRegistry();
    options = {
      port: testPort,
      host: "127.0.0.1",
      prefix: "/svc",
    };
    gateway = new ServiceGateway(registry, options);
  });

  afterEach(async () => {
    // Ensure gateway is stopped after each test
    try {
      await gateway.stop();
    } catch {
      // Ignore errors if not running
    }
    // Wait for port to be fully released
    await new Promise((r) => setTimeout(r, 100));
  });

  describe("start and port", () => {
    it("should start and listen on configured port", async () => {
      await gateway.start();
      expect(gateway.port).toBe(testPort);

      // Verify the server is actually listening
      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: testPort,
        path: "/health",
        method: "GET",
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
    });
  });

  describe("proxying", () => {
    it("should proxy requests to registered services by path: GET /{prefix}/{serviceId}/path → service", async () => {
      // Register a test service with a mock HTTP server
      const mockServiceServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ proxied: true, path: req.url }));
      });

      await new Promise<void>((resolve) => {
        mockServiceServer.listen(13001, "127.0.0.1", () => resolve());
      });

      try {
        const entry = createMockEntry({
          id: "my-service",
          url: "http://127.0.0.1:13001",
          healthy: true,
          expose: "gateway",
        });
        registry.register(entry);

        await gateway.start();

        // Wait for server to be ready
        await new Promise((r) => setTimeout(r, 50));

        // Request through gateway
        const response = await httpRequest({
          hostname: "127.0.0.1",
          port: testPort,
          path: "/svc/my-service/api/users",
          method: "GET",
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.proxied).toBe(true);
        expect(body.path).toBe("/api/users");
      } finally {
        mockServiceServer.close();
      }
    });

    it("should return 404 for unknown service ID", async () => {
      await gateway.start();

      // Wait for server to be ready
      await new Promise((r) => setTimeout(r, 50));

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: testPort,
        path: "/svc/nonexistent-service/some/path",
        method: "GET",
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return 503 for unhealthy service", async () => {
      const entry = createMockEntry({
        id: "unhealthy-service",
        url: "http://127.0.0.1:13002",
        healthy: false,
        expose: "gateway",
      });
      registry.register(entry);

      await gateway.start();

      // Wait for server to be ready
      await new Promise((r) => setTimeout(r, 50));

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: testPort,
        path: "/svc/unhealthy-service/api/data",
        method: "GET",
      });

      expect(response.statusCode).toBe(503);
    });
  });

  describe("stop", () => {
    it("should stop cleanly and free the port", async () => {
      await gateway.start();
      const port = gateway.port;

      // Verify it's listening
      await httpRequest({
        hostname: "127.0.0.1",
        port: port,
        path: "/health",
        method: "GET",
      });

      await gateway.stop();

      // Verify the port is freed by trying to bind to it again
      const newGateway = new ServiceGateway(registry, { ...options, port });
      await newGateway.start();

      // Should be able to get the port
      expect(newGateway.port).toBe(port);

      await newGateway.stop();
    });
  });

  describe("CORS", () => {
    it("should add CORS headers when configured", async () => {
      const corsOptions: GatewayOptions = {
        port: testPort + 1,
        host: "127.0.0.1",
        prefix: "/svc",
        cors: {
          origins: ["http://example.com", "http://localhost:3000"],
          credentials: true,
        },
      };
      const corsGateway = new ServiceGateway(registry, corsOptions);

      // Register a service
      const entry = createMockEntry({
        id: "cors-service",
        url: "http://127.0.0.1:13003",
        healthy: true,
        expose: "gateway",
      });
      registry.register(entry);

      await corsGateway.start();

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: testPort + 1,
        path: "/svc/cors-service/api/test",
        method: "GET",
        headers: {
          Origin: "http://localhost:3000",
        },
      });

      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(response.headers["access-control-allow-credentials"]).toBe("true");

      await corsGateway.stop();
    });
  });

  describe("auth middleware", () => {
    const authPort = 18450;
    let keyStore: ServiceKeyStore;
    let minter: TokenMinter;
    let authGateway: ServiceGateway;
    let mockServer: http.Server;

    beforeEach(async () => {
      keyStore = new ServiceKeyStore("/tmp/test-secrets");
      minter = new TokenMinter(keyStore);

      // Generate a key pair for the test service
      await keyStore.generateKeyPair("auth-service");

      // Create a mock backend service
      mockServer = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ proxied: true, path: req.url }));
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(13010, "127.0.0.1", () => resolve());
      });

      // Register the service
      const entry = createMockEntry({
        id: "auth-service",
        url: "http://127.0.0.1:13010",
        healthy: true,
        expose: "gateway",
      });
      registry.register(entry);
    });

    afterEach(async () => {
      try {
        await authGateway?.stop();
      } catch {
        // Ignore
      }
      mockServer?.close();
      await new Promise((r) => setTimeout(r, 100));
    });

    it("should return 401 when auth required and no token provided", async () => {
      authGateway = new ServiceGateway(registry, {
        port: authPort,
        host: "127.0.0.1",
        prefix: "/svc",
        auth: { keyStore, required: true },
      });
      await authGateway.start();
      await new Promise((r) => setTimeout(r, 50));

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: authPort,
        path: "/svc/auth-service/api/data",
        method: "GET",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Authorization token required");
    });

    it("should return 401 when auth required and invalid token provided", async () => {
      authGateway = new ServiceGateway(registry, {
        port: authPort,
        host: "127.0.0.1",
        prefix: "/svc",
        auth: { keyStore, required: true },
      });
      await authGateway.start();
      await new Promise((r) => setTimeout(r, 50));

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: authPort,
        path: "/svc/auth-service/api/data",
        method: "GET",
        headers: {
          Authorization: "Bearer invalid-token-value",
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Invalid or expired token");
    });

    it("should proxy successfully when auth required and valid token provided", async () => {
      authGateway = new ServiceGateway(registry, {
        port: authPort,
        host: "127.0.0.1",
        prefix: "/svc",
        auth: { keyStore, required: true },
      });
      await authGateway.start();
      await new Promise((r) => setTimeout(r, 50));

      // Mint a valid token for the service
      const token = await minter.mint("test-agent", "auth-service", "urn:session:test");

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: authPort,
        path: "/svc/auth-service/api/data",
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.proxied).toBe(true);
      expect(body.path).toBe("/api/data");
    });

    it("should proxy without auth when auth not configured", async () => {
      // Use the default gateway (no auth config)
      authGateway = new ServiceGateway(registry, {
        port: authPort,
        host: "127.0.0.1",
        prefix: "/svc",
      });
      await authGateway.start();
      await new Promise((r) => setTimeout(r, 50));

      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: authPort,
        path: "/svc/auth-service/api/data",
        method: "GET",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.proxied).toBe(true);
    });
  });
});
