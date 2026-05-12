/**
 * Canvas Server Entry Point
 */

import express, { type Express, type Application } from "express";
import { createServer, type Server as HttpServer } from "http";
import { Gateway } from "./services/gateway.js";
import { createAgentProxyRouter } from "./routes/agent-proxy.js";
import { createFileSpawnRouter } from "./routes/file-spawn.js";
import { DEFAULT_CANVAS_CONFIG, type CanvasConfig } from "./config.js";

export interface CanvasServer {
  server: HttpServer;
  gateway: Gateway;
  app: Application;
  close: () => Promise<void>;
}

export interface CreateCanvasServerOptions {
  sessionsSpawn?: Function;
}

export function createCanvasServer(
  config: Partial<CanvasConfig>,
  opts?: CreateCanvasServerOptions,
): CanvasServer {
  // Merge config with defaults
  const fullConfig: CanvasConfig = {
    ...DEFAULT_CANVAS_CONFIG,
    ...config,
  };

  // Get sessionsSpawn function or use a default that throws
  const spawnFn =
    opts?.sessionsSpawn ??
    (() => {
      throw new Error("sessionsSpawn not configured");
    });

  // Create Express app
  const app: Express = express();
  app.use(express.json());

  // Register routes - pass sessionsSpawn to both routers
  app.use("/api/agent", createAgentProxyRouter({ sessionsSpawn: spawnFn }));
  app.use(
    "/api/file-spawn",
    createFileSpawnRouter({
      sessionsSpawn: spawnFn,
      canvasRoot: fullConfig.basePath || process.cwd(),
    }),
  );

  // Create HTTP server
  const server = createServer(app);

  // Create Gateway with the HTTP server for WebSocket support
  const gateway = new Gateway({ server });

  // Start listening
  server.listen(fullConfig.port, fullConfig.host);

  // Return server object
  return {
    server,
    gateway,
    app,
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
