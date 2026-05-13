/**
 * Shoggoth Canvas Server Entry Point
 */

import express, { type Express } from "express";
import { createServer as createHttpServer, type Server as HttpServer } from "http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getLogger } from "@shoggoth/shared";

import { FileResolver } from "./services/file-resolver";
import { SessionManager } from "./services/session-manager";
import { Gateway } from "./services/gateway";
import { A2UIStore } from "./services/a2ui-store";
import { A2UIManager } from "./services/a2ui-manager";
import { CatalogRegistry } from "./services/catalog-registry";
import { FileWatcher } from "./services/file-watcher";
import { JSONLWatcher } from "./services/jsonl-watcher";

import { canvasRoute } from "./routes/canvas";
import { scaffoldRoute } from "./routes/scaffold";
import { canvasConfigRoute } from "./routes/canvas-config";
import { catalogsRoute } from "./routes/catalogs";
import { createAgentProxyRouter } from "./routes/agent-proxy";
import { createFileSpawnRouter } from "./routes/file-spawn";

import { registerCanvasCommands } from "./commands/canvas";
import { registerA2UICommands } from "./commands/a2ui";

import { DEFAULT_CANVAS_CONFIG, type CanvasConfig } from "./config";

const log = getLogger("service-canvas");

export interface CanvasServer {
  app: Express;
  server: HttpServer;
  gateway: Gateway;
  sessionManager: SessionManager;
  a2uiManager: A2UIManager;
  catalogRegistry: CatalogRegistry;
  fileResolver: FileResolver;
  close: () => Promise<void>;
}

export interface CreateCanvasServerOptions {
  sessionsSpawn?: Function;
  /** Optional path to discover catalogs from (defaults to cwd) */
  catalogRoot?: string;
}

export function createCanvasServer(
  config: Partial<CanvasConfig> = {},
  opts?: CreateCanvasServerOptions,
): CanvasServer {
  const fullConfig: CanvasConfig = {
    ...DEFAULT_CANVAS_CONFIG,
    ...config,
  };

  const basePath = fullConfig.basePath.replace(/\/+$/, "");
  const canvasRoot = path.resolve(
    fullConfig.agentWorkspaces["__default"] ?? process.cwd(),
    "canvas",
  );
  fs.mkdirSync(canvasRoot, { recursive: true });

  // Build agent workspace map from config
  const agentWorkspaceMap = new Map<string, string>();
  for (const [agentId, workspace] of Object.entries(fullConfig.agentWorkspaces)) {
    if (agentId === "__default") continue;
    const canvasDir = path.join(workspace, "canvas");
    fs.mkdirSync(canvasDir, { recursive: true });
    agentWorkspaceMap.set(agentId, canvasDir);
  }

  // Instantiate services
  const fileResolver = new FileResolver(agentWorkspaceMap, canvasRoot);
  const sessionManager = new SessionManager();
  const a2uiStore = new A2UIStore(fullConfig.a2uiDbPath);
  const a2uiManager = new A2UIManager(a2uiStore);
  const catalogRegistry = new CatalogRegistry();

  // Discover catalogs
  const catalogRoot = opts?.catalogRoot ?? process.cwd();
  catalogRegistry.discover(catalogRoot).catch((err) => {
    log.error("catalog discovery failed", { err: String(err) });
  });

  const resolveSchema = catalogRegistry.getComponentSchema?.bind(catalogRegistry);

  // Sessions spawn function
  const spawnFn =
    opts?.sessionsSpawn ??
    (() => {
      throw new Error("sessionsSpawn not configured");
    });

  // Create Express app
  const app: Express = express();
  app.use(express.json());

  // Mount API and canvas-file routes first (before SPA catch-all)
  app.use(canvasRoute(fileResolver, basePath));
  app.use(scaffoldRoute());
  app.use(canvasConfigRoute());
  app.use(catalogsRoute(catalogRegistry));
  app.use("/api/agent", createAgentProxyRouter({ sessionsSpawn: spawnFn }));
  app.use(
    "/api/file-spawn",
    createFileSpawnRouter({
      sessionsSpawn: spawnFn,
      canvasRoot,
    }),
  );

  // Serve the built SPA client (static assets + SPA fallback)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const clientDistDir = path.resolve(thisDir, "../../dist/client");
  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir));
    // SPA fallback: serve index.html for any unmatched GET that accepts HTML
    app.get("/{*splat}", (req, res, next) => {
      // Don't intercept API, WebSocket, or canvas-file routes
      if (
        req.path.startsWith("/api/") ||
        req.path.startsWith("/_c/") ||
        req.path.startsWith("/scaffold") ||
        req.path.startsWith("/ws") ||
        req.path.startsWith("/gateway")
      ) {
        return next();
      }
      const indexPath = path.join(clientDistDir, "index.html");
      res.sendFile(indexPath);
    });
  } else {
    log.warn("client dist not found, SPA will not be served", { clientDistDir });
  }

  // Create HTTP server
  const server = createHttpServer(app);

  // Create Gateway with WebSocket support
  const gateway = new Gateway({ server });
  gateway.setA2UIManager?.(a2uiManager);
  gateway.setSchemaResolver?.(resolveSchema);

  // Register commands on the gateway
  registerCanvasCommands(gateway, sessionManager);
  registerA2UICommands(gateway, a2uiManager, resolveSchema);

  // Replay cached A2UI state to newly connected SPA clients
  gateway.onSpaConnect?.((ws: unknown) => {
    const session = gateway.getSpaSession?.(ws) ?? "main";
    for (const surface of a2uiManager.surfacesForSession(session)) {
      const components = Array.from(surface.components.entries()).map(([id, component]) => ({
        id,
        ...component,
      }));
      gateway.sendToSpa?.(ws, {
        type: "a2ui.updateComponents",
        session,
        surfaceId: surface.surfaceId,
        components,
      });
      if (surface.dataModel && Object.keys(surface.dataModel).length > 0) {
        gateway.sendToSpa?.(ws, {
          type: "a2ui.updateDataModel",
          session,
          surfaceId: surface.surfaceId,
          data: surface.dataModel,
        });
      }
      if (surface.root) {
        const msg: Record<string, unknown> = {
          type: "a2ui.createSurface",
          session,
          surfaceId: surface.surfaceId,
          root: surface.root,
        };
        if (surface.catalogId) msg.catalogId = surface.catalogId;
        if (surface.theme) msg.theme = surface.theme;
        gateway.sendToSpa?.(ws, msg);
      }
    }
  });

  // Set up file watchers
  const sessionPathMap = new Map<string, string>();
  sessionPathMap.set("main", canvasRoot);
  for (const [agentId, canvasDir] of agentWorkspaceMap) {
    sessionPathMap.set(agentId, canvasDir);
  }

  const fileWatcher = new FileWatcher(sessionPathMap, gateway, {
    ignoreDirs: fullConfig.ignoreDirs,
  });
  const jsonlWatcher = new JSONLWatcher(sessionPathMap, gateway, a2uiManager, {}, resolveSchema);

  // Start listening
  server.listen(fullConfig.port, fullConfig.host, () => {
    const addr = server.address();
    const bound = typeof addr === "string" ? addr : `${addr?.address}:${addr?.port}`;
    log.info("canvas server listening", { address: bound, canvasRoot });
  });

  return {
    app,
    server,
    gateway,
    sessionManager,
    a2uiManager,
    catalogRegistry,
    fileResolver,
    close: async () => {
      jsonlWatcher.close();
      await fileWatcher.close();
      gateway.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
