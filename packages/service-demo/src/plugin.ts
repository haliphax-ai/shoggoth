import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEMO_TOOLS, DEFAULT_MESSAGE, escapeHtml } from "./shared.js";

const DEFAULT_PORT = 3200;

/** In-memory message displayed by the demo service. */
let message = DEFAULT_MESSAGE;

/** HTTP server instance. */
let server: Server | undefined;

function pageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo Service</title></head>
<body>
<h1>Demo Service</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Serve the demo page on GET /; 405 for other methods, 404 elsewhere. */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname !== "/") {
    json(res, 404, { error: "not found" });
    return;
  }

  if (method !== "GET") {
    res.setHeader("Allow", "GET");
    json(res, 405, { error: "method not allowed" });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(pageHtml());
}

export function startServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => handleRequest(req, res));
    srv.listen(port, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

export default function createDemoServicePlugin(): Plugin<ShoggothHooks> {
  return {
    name: "service-demo",
    hooks: {
      "daemon.configure"(ctx) {
        return ctx;
      },

      async "service.register"(ctx) {
        server = await startServer(DEFAULT_PORT);

        ctx.registerService({
          id: "demo",
          label: "Demo",
          capabilities: ["demo"],
          expose: "gateway",
          port: DEFAULT_PORT,
          protocol: "http",
          basePath: "/",
        });

        ctx.registerTools(
          DEMO_TOOLS.map((tool) => ({
            ...tool,
            handler:
              tool.name === "demo.set_message"
                ? async (args: Record<string, unknown>) => {
                    message = args.message as string;
                    return {
                      resultJson: JSON.stringify({ ok: true, message }),
                    };
                  }
                : async () => ({
                    resultJson: JSON.stringify({ message }),
                  }),
          })),
        );
      },

      "health.register"(ctx) {
        ctx.registerProbe({
          name: "demo",
          check: async () => ({
            status: server?.listening ? "pass" : "fail",
          }),
        });
      },

      async "daemon.shutdown"() {
        if (server) {
          await new Promise<void>((resolve) => server!.close(() => resolve()));
          server = undefined;
        }
      },
    },
  };
}
