/**
 * Gateway Service Tests
 */

import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import type { WebSocket as ClientWebSocket } from "ws";
import { Gateway, type SpaSession } from "../../../src/server/services/gateway";

describe("Gateway", () => {
  it("should be instantiable", () => {
    expect(() => new Gateway()).not.toThrow();
  });

  it("defaults the active session to main", () => {
    const gateway = new Gateway();
    expect(gateway.getActiveSession()).toBe("main");
  });

  it("updates the active session", () => {
    const gateway = new Gateway();
    gateway.setActiveSession("other");
    expect(gateway.getActiveSession()).toBe("other");
  });

  it("should have broadcastSpaSession method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.broadcastSpaSession).toBe("function");
  });

  it("should have broadcastSpa method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.broadcastSpa).toBe("function");
  });

  it("should have requestSnapshot method that returns a Promise", () => {
    const gateway = new Gateway();
    const session: SpaSession = { id: "test-session" };

    const result = gateway.requestSnapshot(session);
    expect(result).toBeInstanceOf(Promise);
  });

  it("should have close method", () => {
    const gateway = new Gateway();
    expect(typeof gateway.close).toBe("function");
  });

  describe("requestSnapshot", () => {
    function startServer(): Promise<Server> {
      return new Promise((resolve) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    }

    function connectSpa(server: Server, session: string): Promise<ClientWebSocket> {
      return new Promise((resolve, reject) => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("server address unavailable"));
          return;
        }
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}/?session=${session}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    }

    it("resolves with an empty string when no SPA client is connected", async () => {
      const gateway = new Gateway();
      const result = await gateway.requestSnapshot("no-client-session");
      expect(result).toBe("");
    });

    it("queues concurrent requests instead of overwriting them", async () => {
      const server = await startServer();
      const gateway = new Gateway({ server });
      const ws = await connectSpa(server, "queued-session");

      try {
        const first = gateway.requestSnapshot("queued-session");
        const second = gateway.requestSnapshot("queued-session");

        const firstData = JSON.stringify({
          type: "snapshot",
          sessionId: "queued-session",
          data: "first",
        });
        const secondData = JSON.stringify({
          type: "snapshot",
          sessionId: "queued-session",
          data: "second",
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Snapshot responses resolve the queued requests in FIFO order.
        ws.send(firstData);
        expect(await first).toBe("first");
        ws.send(secondData);
        expect(await second).toBe("second");
      } finally {
        gateway.close();
        server.close();
        ws.close();
      }
    });
  });
});
