import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { ServiceGateway, GatewayOptions } from "../src/gateway";
import { ServiceRegistry, ServiceEntry } from "../src/service-registry";

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

/**
 * Compute the WebSocket accept key from a client key.
 */
function computeAcceptKey(clientKey: string): string {
  return crypto
    .createHash("sha1")
    .update(clientKey + "258EAFA5-E914-47DA-95CA-5AB5DC85B11C")
    .digest("base64");
}

/**
 * Create a minimal WebSocket echo server that handles the upgrade handshake
 * and echoes back any frames received.
 */
function createWsEchoServer(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let handshakeDone = false;
      let buffer = Buffer.alloc(0);

      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);

        if (!handshakeDone) {
          // Look for end of HTTP headers
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;

          const headerStr = buffer.slice(0, headerEnd).toString();
          const lines = headerStr.split("\r\n");

          // Extract Sec-WebSocket-Key
          let wsKey = "";
          for (const line of lines) {
            const match = line.match(/^Sec-WebSocket-Key:\s*(.+)$/i);
            if (match) {
              wsKey = match[1].trim();
              break;
            }
          }

          // Send upgrade response
          const acceptKey = computeAcceptKey(wsKey);
          const response =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
            "\r\n";
          socket.write(response);
          handshakeDone = true;

          // Process remaining data after headers as WebSocket frames
          buffer = buffer.slice(headerEnd + 4);
          if (buffer.length > 0) {
            processFrames(socket, buffer);
            buffer = Buffer.alloc(0);
          }
        } else {
          // Process WebSocket frames
          processFrames(socket, buffer);
          buffer = Buffer.alloc(0);
        }
      });
    });

    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

/**
 * Process incoming WebSocket frames and echo them back (unmasked).
 */
function processFrames(socket: net.Socket, data: Buffer): void {
  // Minimal frame parser: handle small text frames
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 2) break;

    const firstByte = data[offset];
    const secondByte = data[offset + 1];
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    offset += 2;

    if (payloadLen === 126) {
      if (data.length - offset < 2) break;
      payloadLen = data.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      // Skip 64-bit length for simplicity
      break;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (data.length - offset < 4) break;
      maskKey = data.slice(offset, offset + 4);
      offset += 4;
    }

    if (data.length - offset < payloadLen) break;

    const payload = Buffer.alloc(payloadLen);
    data.copy(payload, 0, offset, offset + payloadLen);
    offset += payloadLen;

    // Unmask if needed
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    // Echo back as unmasked text frame
    const opcode = firstByte & 0x0f;
    if (opcode === 0x08) {
      // Close frame - send close back
      const closeFrame = Buffer.from([0x88, 0x00]);
      socket.write(closeFrame);
      socket.end();
      return;
    }

    // Echo the payload back
    const responseFrame = buildFrame(payload, opcode);
    socket.write(responseFrame);
  }
}

/**
 * Build an unmasked WebSocket frame.
 */
function buildFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Send a WebSocket upgrade request through the gateway and return the response.
 * Returns the raw socket for further communication if upgrade succeeds.
 */
function sendUpgradeRequest(
  port: number,
  path: string,
): Promise<{ statusCode: number; headers: string; socket: net.Socket; rawResponse: string }> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`;
      socket.write(request);
    });

    let responseData = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Upgrade request timeout"));
    }, 5000);

    socket.on("data", function onData(data) {
      responseData += data.toString();
      const headerEnd = responseData.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        clearTimeout(timeout);
        const statusLine = responseData.split("\r\n")[0];
        const statusCode = parseInt(statusLine.split(" ")[1], 10);
        socket.removeListener("data", onData);
        resolve({
          statusCode,
          headers: responseData.slice(0, headerEnd),
          socket,
          rawResponse: responseData,
        });
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
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
    // Allow port to be fully released between tests
    await new Promise((r) => setTimeout(r, 50));
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


      const response = await httpRequest({
        hostname: "127.0.0.1",
        port: testPort,
        path: "/svc/unhealthy-service/api/data",
        method: "GET",
      });

      expect(response.statusCode).toBe(503);
    });
  });

  describe("WebSocket upgrade", () => {
    const wsBackendPort = 13050;
    let wsEchoServer: net.Server;

    beforeEach(async () => {
      wsEchoServer = await createWsEchoServer(wsBackendPort);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        wsEchoServer.close(() => resolve());
      });
    });

    it("should proxy upgrade request to ws-capable service", async () => {
      const entry = createMockEntry({
        id: "ws-service",
        url: `http://127.0.0.1:${wsBackendPort}`,
        wsUrl: `ws://127.0.0.1:${wsBackendPort}`,
        healthy: true,
        expose: "gateway",
      });
      registry.register(entry);

      await gateway.start();

      const { statusCode, socket } = await sendUpgradeRequest(testPort, "/svc/ws-service/echo");

      expect(statusCode).toBe(101);

      // Send a WebSocket text frame and verify echo
      const testMessage = "hello websocket";
      const payload = Buffer.from(testMessage);
      const maskKey = crypto.randomBytes(4);
      const maskedPayload = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        maskedPayload[i] = payload[i] ^ maskKey[i % 4];
      }
      const frame = Buffer.concat([
        Buffer.from([0x81, 0x80 | payload.length]),
        maskKey,
        maskedPayload,
      ]);

      const echoPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Echo timeout")), 3000);
        socket.on("data", (data) => {
          clearTimeout(timeout);
          // Parse the response frame (unmasked)
          if (data.length >= 2) {
            const len = data[1] & 0x7f;
            const payloadStart = 2;
            const echoPayload = data.slice(payloadStart, payloadStart + len);
            resolve(echoPayload.toString());
          }
        });
      });

      socket.write(frame);

      const echoResult = await echoPromise;
      expect(echoResult).toBe(testMessage);

      socket.destroy();
    });

    it("should return error for http-only service (no wsUrl)", async () => {
      const entry = createMockEntry({
        id: "http-only-service",
        url: "http://127.0.0.1:13051",
        wsUrl: undefined,
        healthy: true,
        expose: "gateway",
      });
      registry.register(entry);

      await gateway.start();

      const { statusCode, socket } = await sendUpgradeRequest(
        testPort,
        "/svc/http-only-service/ws",
      );

      expect(statusCode).toBe(426);
      socket.destroy();
    });

    it("should return error for unknown service", async () => {
      await gateway.start();

      const { statusCode, socket } = await sendUpgradeRequest(
        testPort,
        "/svc/nonexistent-service/ws",
      );

      expect(statusCode).toBe(404);
      socket.destroy();
    });

    it("should return error for unhealthy service", async () => {
      const entry = createMockEntry({
        id: "unhealthy-ws-service",
        url: `http://127.0.0.1:${wsBackendPort}`,
        wsUrl: `ws://127.0.0.1:${wsBackendPort}`,
        healthy: false,
        expose: "gateway",
      });
      registry.register(entry);

      await gateway.start();

      const { statusCode, socket } = await sendUpgradeRequest(
        testPort,
        "/svc/unhealthy-ws-service/ws",
      );

      expect(statusCode).toBe(503);
      socket.destroy();
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
});

