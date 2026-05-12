/**
 * Canvas Service Plugin Entry Point
 */

import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks, DirectServiceTool, ServiceRegisterCtx } from "@shoggoth/plugins";
import { createCanvasServer, type CanvasServer } from "./server/index.js";
import { DEFAULT_CANVAS_CONFIG, type CanvasConfig } from "./server/config.js";
import type { Gateway } from "./server/services/gateway.js";

/**
 * Canvas-specific config that can be provided via ShoggothConfig.services.canvas
 */
interface CanvasServiceConfig {
  port?: number;
  host?: string;
  basePath?: string;
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
  // Create module-level state for this plugin instance
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
        const config: CanvasConfig = {
          ...DEFAULT_CANVAS_CONFIG,
          ...userConfig,
        };

        // Create and start the canvas server
        canvasServer = createCanvasServer(config);
        gateway = canvasServer.gateway;

        // Wait for server to start listening
        await new Promise<void>((resolve) => {
          canvasServer!.server.once("listening", resolve);
          // In case it's already listening (sync case)
          if (canvasServer!.server.listening) resolve();
        });

        // Register this as a service
        ctx.registerService({
          id: "canvas",
          expose: "both",
          protocol: "http+ws",
          port: config.port,
        });

        // Register all 8 canvas tools
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
 * Returns the 8 canvas tool definitions.
 * Each tool handler delegates to the gateway instance.
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
        const { target, surface } = args as {
          target?: string;
          surface?: string;
        };
        // Use session from args, fallback to context sessionUrn
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "canvas.show",
          session,
          target,
          surface,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
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
        gatewayRef?.broadcastSpa({ type: "canvas.hide" });
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    },
    {
      name: "canvas.navigate",
      description: "Navigate a session's canvas to a URL.",
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
          url: {
            type: "string",
            description: "Full URL to navigate to",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        const { path, url } = args as {
          path?: string;
          url?: string;
        };
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "canvas.navigate",
          session,
          path,
          url,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    },
    {
      name: "canvas.eval",
      description: "Execute JavaScript in a session's canvas context.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to execute JS in",
          },
          js: {
            type: "string",
            description: "JavaScript code to execute",
          },
        },
        required: ["session", "js"],
      },
      async handler(args, ctx) {
        const { js } = args as { js?: string };
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "canvas.eval",
          session,
          js,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
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
        const session = (args.session as string) || ctx.sessionUrn;
        const snapshot = await gatewayRef?.requestSnapshot(session);
        return { resultJson: JSON.stringify({ ok: true, snapshot }) };
      },
    },
    {
      name: "canvas.a2ui.push",
      description: "Push A2UI (Agent-to-User Interface) data to a session.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to push A2UI data to",
          },
          payload: {
            type: "object",
            description: "A2UI payload data to push",
          },
        },
        required: ["session", "payload"],
      },
      async handler(args, ctx) {
        const { payload } = args as { payload?: unknown };
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "a2ui.push",
          session,
          payload,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    },
    {
      name: "canvas.a2ui.pushJSONL",
      description: "Push A2UI data as JSONL to a session (alias for a2ui.push).",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "Session ID to push A2UI data to",
          },
          payload: {
            type: "object",
            description: "A2UI payload data to push",
          },
        },
        required: ["session", "payload"],
      },
      async handler(args, ctx) {
        // Same as a2ui.push - this is an alias
        const { payload } = args as { payload?: unknown };
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "a2ui.push",
          session,
          payload,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
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
        const session = (args.session as string) || ctx.sessionUrn;
        gatewayRef?.broadcastSpaSession(session, {
          type: "a2ui.reset",
          session,
        });
        return { resultJson: JSON.stringify({ ok: true }) };
      },
    },
  ];
}
