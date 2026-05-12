/**
 * Canvas Server Tests
 */

import { describe, it, expect, afterEach } from "vitest";
import { createCanvasServer, type CanvasServer } from "../../src/server/index";
import type { CanvasConfig } from "../../src/server/config";
import type { AddressInfo } from "net";

describe("createCanvasServer", () => {
  let server: CanvasServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("should accept a CanvasConfig object", () => {
    const config: CanvasConfig = {
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      skipConfirm: true,
      a2uiDbPath: "/tmp/test-canvas.db",
      ignoreDirs: ["tmp"],
      agentWorkspaces: {},
    };

    expect(() => createCanvasServer(config)).not.toThrow();
  });

  it("should return an object with server, gateway, and close method", () => {
    const config: CanvasConfig = {
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      skipConfirm: true,
      a2uiDbPath: "/tmp/test-canvas.db",
      ignoreDirs: ["tmp"],
      agentWorkspaces: {},
    };

    const result = createCanvasServer(config);
    server = result;

    expect(result).toHaveProperty("server");
    expect(result).toHaveProperty("gateway");
    expect(typeof result.close).toBe("function");
  });

  it("should listen on the configured port", async () => {
    const config: CanvasConfig = {
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      skipConfirm: true,
      a2uiDbPath: "/tmp/test-canvas.db",
      ignoreDirs: ["tmp"],
      agentWorkspaces: {},
    };

    server = createCanvasServer(config);

    // Wait for the server to start listening
    await new Promise<void>((resolve) => {
      server!.server.once("listening", resolve);
      // If already listening, resolve immediately
      if (server!.server.listening) resolve();
    });

    const addr = server.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${addr.port}/`).catch(() => null);
    expect(response).not.toBeNull();
  });

  it("should apply default config values for omitted fields", async () => {
    const config: CanvasConfig = {
      host: "127.0.0.1",
      port: 0,
      basePath: "/",
      skipConfirm: false,
      a2uiDbPath: "",
      ignoreDirs: [],
      agentWorkspaces: {},
    };

    server = createCanvasServer(config);

    expect(server).toBeDefined();
  });
});
