/**
 * Canvas Service Plugin Entry Point
 */

import path from "node:path";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks, DirectServiceTool, ServiceRegisterCtx } from "@shoggoth/plugins";
import { createCanvasServer, type CanvasServer } from "./server/index";
import { DEFAULT_CANVAS_CONFIG, type CanvasConfig } from "./server/config";
import type { Gateway } from "./server/services/gateway";

/**
 * Canvas-specific config that can be provided via ShoggothConfig.services.canvas
 */
interface CanvasServiceConfig {
  port?: number;
  host?: string;
  basePath?: string;
  a2uiDbPath?: string;
  ignoreDirs?: string[];
  agentWorkspaces?: Record<string, string>;
}

/**
 * Extended context type that includes services config
 */
interface ExtendedServiceRegisterCtx extends Omit<ServiceRegisterCtx, "config"> {
  config: ServiceRegisterCtx["config"] & {
    services?: {
      canvas?: CanvasServiceConfig;
    };
  };
}

/**
 * Create the Canvas service plugin.
 * This plugin provides canvas manipulation tools and an A2UI WebSocket gateway.
 */
export default function createCanvasPlugin(): Plugin<ShoggothHooks> {
  let canvasServer: CanvasServer | undefined;
  let gateway: Gateway | undefined;

  return {
    name: "service-canvas",
    hooks: {
      "daemon.configure"(ctx) {
        return ctx;
      },

      async "service.register"(ctx) {
        const typedCtx = ctx as ExtendedServiceRegisterCtx;

        // Merge user config with defaults
        const userConfig = typedCtx.config.services?.canvas ?? {};

        // Derive agent workspaces from daemon config (workspacesRoot + agents.list)
        const workspacesRoot = typedCtx.config.workspacesRoot;
        const agentWorkspaces: Record<string, string> = {
          __default: workspacesRoot,
          ...userConfig.agentWorkspaces,
        };

        // Auto-populate from agents.list if not explicitly provided
        const agentsList = typedCtx.config.agents?.list;
        if (agentsList) {
          for (const agentId of Object.keys(agentsList)) {
            if (!agentWorkspaces[agentId]) {
              agentWorkspaces[agentId] = path.join(workspacesRoot, agentId);
            }
          }
        }

        const config: CanvasConfig = {
          ...DEFAULT_CANVAS_CONFIG,
          ...userConfig,
          agentWorkspaces,
        };

        // Create and start the canvas server
        canvasServer = createCanvasServer(config);
        gateway = canvasServer.gateway;

        // Wait for server to start listening
        await new Promise<void>((resolve) => {
          canvasServer!.server.once("listening", resolve);
          if (canvasServer!.server.listening) resolve();
        });

        // Register this as a service
        ctx.registerService({
          id: "canvas",
          expose: "both",
          protocol: "http+ws",
          port: config.port,
        });

        // Register all canvas tools
        ctx.registerTools(getCanvasTools(gateway));
      },

      "health.register"(ctx) {
        ctx.registerProbe({
          name: "canvas",
          check: async () => ({
            status: canvasServer?.server?.listening ? "pass" : "fail",
          }),
        });
      },

      async "daemon.shutdown"() {
        if (canvasServer) {
          await canvasServer.close();
          canvasServer = undefined;
          gateway = undefined;
        }
      },
    },
  };
}

/**
 * Normalize a session identifier for the canvas system.
 * Full session URNs (agent:main:discord:channel:123) are reduced to the agent ID ("main").
 * Plain strings are returned as-is.
 */
function normalizeSession(session: string): string {
  const parsed = parseAgentSessionUrn(session);
  return parsed ? parsed.agentId : session;
}

/**
 * Returns the canvas tool definitions.
 * Each tool handler dispatches through the gateway to the registered command handlers.
 */
function getCanvasTools(gatewayRef: Gateway | undefined): DirectServiceTool[] {
  return [
    {
      name: "canvas.present",
      description:
        "Present a canvas surface to a session. Opens a canvas for the user to interact with.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "The target canvas ID to present",
          },
          surface: {
            type: "string",
            description: "The surface name to display",
          },
          session: {
            type: "string",
            description: "Session ID to present the canvas to",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        const session = normalizeSession((args.session as string) || ctx.sessionUrn);
        const result = await gatewayRef?.dispatch("canvas.show", {
          session,
          target: args.target,
          surface: args.surface,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.hide",
      description: "Hide the canvas from all connected sessions.",
      parameters: {
        type: "object",
        properties: {},
      },
      async handler() {
        const result = await gatewayRef?.dispatch("canvas.hide", {});
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.navigate",
      description: "Navigate a session's canvas to a path.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to navigate",
          },
          path: {
            type: "string",
            description: "Path to navigate to",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        const session = normalizeSession((args.session as string) || ctx.sessionUrn);
        const result = await gatewayRef?.dispatch("canvas.navigate", {
          session,
          path: args.path,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.navigateExternal",
      description: "Navigate the canvas to an external URL (http/https only).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to navigate to (http or https)",
          },
        },
        required: ["url"],
      },
      async handler(args) {
        const result = await gatewayRef?.dispatch("canvas.navigateExternal", {
          url: args.url,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.eval",
      description: "Execute JavaScript in the canvas context.",
      parameters: {
        type: "object",
        properties: {
          js: {
            type: "string",
            description: "JavaScript code to execute",
          },
          id: {
            type: "string",
            description: "Optional eval ID for tracking",
          },
        },
        required: ["js"],
      },
      async handler(args) {
        const result = await gatewayRef?.dispatch("canvas.eval", {
          js: args.js,
          id: args.id,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.snapshot",
      description: "Request a screenshot/snapshot of a session's canvas. Returns base64 PNG.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to take snapshot of",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        const session = normalizeSession((args.session as string) || ctx.sessionUrn);
        const result = await gatewayRef?.dispatch("canvas.snapshot", {
          id: session,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.a2ui.push",
      description: "Push A2UI (Agent-to-User Interface) JSONL payload to a session.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to push A2UI data to",
          },
          payload: {
            type: "string",
            description: "JSONL payload string containing A2UI commands",
          },
        },
        required: ["session", "payload"],
      },
      async handler(args, ctx) {
        const session = normalizeSession((args.session as string) || ctx.sessionUrn);
        const payload =
          typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
        const result = await gatewayRef?.dispatch("a2ui.push", {
          session,
          payload,
        });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
    {
      name: "canvas.a2ui.reset",
      description: "Reset/clear A2UI state for a session.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to reset A2UI for",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        const session = normalizeSession((args.session as string) || ctx.sessionUrn);
        const result = await gatewayRef?.dispatch("a2ui.reset", { session });
        return { resultJson: JSON.stringify(result ?? { ok: true }) };
      },
    },
  ];
}
