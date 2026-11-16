import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";
import { createServer, type Server } from "node:http";
import { DEMO_TOOLS, DEFAULT_MESSAGE, escapeHtml } from "./shared.js";

const DEFAULT_PORT = 3200;

/** In-memory message displayed by the demo service. */
let message = DEFAULT_MESSAGE;

/** HTTP server instance. */
let server: Server | undefined;

function startServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo Service</title></head>
<body>
<h1>Demo Service</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`);
    });
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
