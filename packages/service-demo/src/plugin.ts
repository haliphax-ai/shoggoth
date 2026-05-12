import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";
import { createServer, type Server } from "node:http";

const DEFAULT_PORT = 3200;

/** In-memory message displayed by the demo service. */
let message = "Hello from the Shoggoth demo service!";

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

        ctx.registerTools([
          {
            name: "demo.set_message",
            description:
              "Set the message displayed by the demo web service. Visit the service URL to see the current message.",
            parameters: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "The new message to display",
                },
              },
              required: ["message"],
            },
            async handler(args) {
              const newMessage = args.message as string;
              message = newMessage;
              return {
                resultJson: JSON.stringify({ ok: true, message }),
              };
            },
          },
          {
            name: "demo.get_message",
            description: "Get the current message displayed by the demo web service.",
            parameters: {
              type: "object",
              properties: {},
            },
            async handler() {
              return {
                resultJson: JSON.stringify({ message }),
              };
            },
          },
        ]);
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
