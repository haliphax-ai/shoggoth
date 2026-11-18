/**
 * Canvas Service Plugin Entry Point
 */

import path from "node:path";
import { parseAgentSessionUrn } from "@shoggoth/shared";
import type { Plugin } from "hooks-plugin";
import type {
  ShoggothHooks,
  DirectServiceTool,
  ServiceRegisterCtx,
  DirectToolContext,
} from "@shoggoth/plugins";
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
          // Set basePath to the gateway prefix so redirects resolve correctly
          basePath: userConfig.basePath ?? "/svc/canvas",
        };

        // Create and start the canvas server
        canvasServer = createCanvasServer(config, {
          sessionsSpawn: ctx.spawnSession,
        });

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
        ctx.registerTools(getCanvasTools(canvasServer!.gateway));
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
        }
      },
    },
  };
}

/**
 * A session identifier resolved for a canvas gateway command, or a rejection
 * describing why the provided value cannot be used.
 */
type ResolvedToolSession = { ok: true; session: string } | { ok: false; error: string };

/** Shape of a valid session URN, shown verbatim in rejection messages. */
const SESSION_URN_SHAPE = "agent:<agentId>:<platform>:<resourceType>:<leaf>";

/**
 * Resolve the `session` argument of a canvas tool to the agent-scoped session
 * key the gateway dispatch uses. Full session URNs
 * (`agent:<agentId>:<platform>:<resourceType>:<leaf>`) are reduced to their
 * agent ID; anything else is rejected instead of silently passed through, so a
 * malformed identifier fails loudly at the tool boundary rather than dispatching
 * against a session key no SPA is subscribed to.
 */
function resolveToolSession(session: string): ResolvedToolSession {
  const parsed = parseAgentSessionUrn(session);
  if (!parsed) {
    return {
      ok: false,
      error: `invalid session: ${JSON.stringify(session)} — must be a session URN of the form ${SESSION_URN_SHAPE}`,
    };
  }
  return { ok: true, session: parsed.agentId };
}

/** Tool result carrying a JSON-serialized payload. */
type ToolResult = { resultJson: string };

/** Serialize a gateway dispatch result (or a gateway-unavailable fallback). */
function toolResult(result: unknown): ToolResult {
  return {
    resultJson: JSON.stringify(result ?? { ok: false, error: "Canvas gateway unavailable" }),
  };
}

/** Single `session` string parameter shared by canvas tools. */
function sessionParamProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

/** Session parameter schema shared by session-taking canvas tools. */
function sessionParam(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      session: { type: "string", description },
    },
    required: ["session"],
  };
}

/**
 * Resolve the tool's session argument (explicit or the invoking session's
 * URN) and run `dispatch` with it, serializing the result. Rejections from
 * `resolveToolSession` are surfaced as structured tool errors.
 */
async function dispatchWithResolvedSession(
  gatewayRef: Gateway | undefined,
  args: Record<string, unknown>,
  ctx: DirectToolContext,
  command: string,
  build: (session: string) => Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = resolveToolSession((args.session as string) || ctx.sessionUrn);
  if (!resolved.ok) {
    return { resultJson: JSON.stringify(resolved) };
  }
  const result = await gatewayRef?.dispatch(command, build(resolved.session));
  return toolResult(result);
}

/**
 * Returns the canvas tool definitions.
 * Each tool handler dispatches through the gateway to the registered command handlers.
 */
function getCanvasTools(gatewayRef: Gateway | undefined): DirectServiceTool[] {
  return [
    {
      name: "canvas-present",
      description:
        "Present a canvas surface to a session. Opens a canvas for the user to interact with.",
      parameters: {
        type: "object",
        properties: {
          target: sessionParamProperty("The target canvas ID to present"),
          surface: {
            type: "string",
            description: "The surface name to display",
          },
          session: sessionParamProperty("Session ID to present the canvas to"),
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        return dispatchWithResolvedSession(gatewayRef, args, ctx, "canvas.show", (session) => ({
          session,
          target: args.target,
          surface: args.surface,
        }));
      },
    },
    {
      name: "canvas-hide",
      description: "Hide the canvas from all connected sessions.",
      parameters: {
        type: "object",
        properties: {},
      },
      async handler() {
        return toolResult(await gatewayRef?.dispatch("canvas.hide", {}));
      },
    },
    {
      name: "canvas-navigate",
      description: "Navigate a session's canvas to a path.",
      parameters: {
        type: "object",
        properties: {
          session: sessionParamProperty("Session ID to navigate"),
          path: {
            type: "string",
            description: "Path to navigate to",
          },
        },
        required: ["session"],
      },
      async handler(args, ctx) {
        return dispatchWithResolvedSession(gatewayRef, args, ctx, "canvas.navigate", (session) => ({
          session,
          path: args.path,
        }));
      },
    },
    {
      name: "canvas-navigateExternal",
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
        return toolResult(await gatewayRef?.dispatch("canvas.navigateExternal", { url: args.url }));
      },
    },
    {
      name: "canvas-eval",
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
        return toolResult(
          await gatewayRef?.dispatch("canvas.eval", {
            js: args.js,
            id: args.id,
          }),
        );
      },
    },
    {
      name: "canvas-snapshot",
      description: "Request a screenshot/snapshot of a session's canvas. Returns base64 PNG.",
      parameters: sessionParam("Session ID to take snapshot of"),
      async handler(args, ctx) {
        return dispatchWithResolvedSession(gatewayRef, args, ctx, "canvas.snapshot", (session) => ({
          id: session,
        }));
      },
    },
    {
      name: "canvas-a2ui-push",
      description: "Push A2UI (Agent-to-User Interface) JSONL payload to a session.",
      parameters: {
        type: "object",
        properties: {
          session: sessionParamProperty("Session ID to push A2UI data to"),
          payload: {
            type: "string",
            description: "JSONL payload string containing A2UI commands",
          },
        },
        required: ["session", "payload"],
      },
      async handler(args, ctx) {
        const resolved = resolveToolSession((args.session as string) || ctx.sessionUrn);
        if (!resolved.ok) {
          return { resultJson: JSON.stringify(resolved) };
        }
        const payload =
          typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
        return toolResult(
          await gatewayRef?.dispatch("a2ui.push", {
            session: resolved.session,
            payload,
          }),
        );
      },
    },
    {
      name: "canvas-a2ui-reset",
      description: "Reset/clear A2UI state for a session.",
      parameters: sessionParam("Session ID to reset A2UI for"),
      async handler(args, ctx) {
        return dispatchWithResolvedSession(gatewayRef, args, ctx, "a2ui.reset", (session) => ({
          session,
        }));
      },
    },
  ];
}
