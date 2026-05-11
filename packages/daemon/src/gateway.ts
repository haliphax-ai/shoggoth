import http from "node:http";
import { ServiceRegistry } from "./service-registry";
import { ServiceKeyStore } from "./service-key-store";
import { TokenValidator } from "./service-auth";

/**
 * Gateway options for configuring the HTTP gateway.
 */
export interface GatewayOptions {
  /** Port to listen on. */
  port: number;
  /** Host address to bind to. */
  host: string;
  /** URL prefix for service routes (e.g., "/svc"). */
  prefix: string;
  /** CORS configuration. */
  cors?: {
    /** Allowed origin strings. */
    origins: string[];
    /** Whether to allow credentials. */
    credentials?: boolean;
  };
  /** Rate limiting configuration. */
  rateLimit?: {
    /** Time window in milliseconds. */
    windowMs: number;
    /** Maximum requests per window. */
    maxRequests: number;
  };
  /** Auth configuration. */
  auth?: {
    /** Key store for looking up service identities. */
    keyStore: ServiceKeyStore;
    /** Whether auth is required for all requests. */
    required: boolean;
  };
}

/**
 * HTTP gateway for proxying requests to registered services.
 *
 * Routes requests like GET /{prefix}/{serviceId}/path → service backend
 */
export class ServiceGateway {
  private server: http.Server | null = null;

  /**
   * Create a new ServiceGateway.
   * @param registry - The service registry to use for routing
   * @param options - Gateway configuration options
   */
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly options: GatewayOptions,
  ) {}

  /**
   * The port the gateway is listening on.
   * @throws Error if the gateway is not running
   */
  get port(): number {
    if (!this.server) {
      throw new Error("Gateway is not running");
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Invalid server address");
    }
    return address.port;
  }

  /**
   * Start the HTTP gateway server.
   */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        console.error("Gateway request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
    });

    // Allow server to drain connections on close
    this.server.on("connection", (socket) => {
      socket.unref();
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.options.port, this.options.host, () => {
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Stop the HTTP gateway server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests and proxy to registered services.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const parsedUrl = new URL(url, `http://${this.options.host}:${this.options.port}`);
    const pathname = parsedUrl.pathname;

    // Handle /health endpoint
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Parse /{prefix}/{serviceId}/{...rest}
    const prefix = this.options.prefix;
    if (!pathname.startsWith(prefix + "/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const pathParts = pathname.slice(prefix.length + 1).split("/");
    if (pathParts.length < 1 || !pathParts[0]) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const serviceId = pathParts[0];
    const restPath = "/" + pathParts.slice(1).join("/");

    // Look up service in registry
    const service = this.registry.get(serviceId);
    if (!service) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Service Not Found");
      return;
    }

    // Check service health
    if (!service.healthy) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service Unavailable");
      return;
    }

    // Auth middleware: validate token if auth is configured and required
    if (this.options.auth?.required) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authorization token required" }));
        return;
      }

      const token = authHeader.slice(7); // Strip "Bearer "

      const identityString = await this.options.auth.keyStore.getIdentity(serviceId);
      if (!identityString) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service identity not found" }));
        return;
      }

      const payload = await TokenValidator.validate(token, identityString);
      if (!payload) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired token" }));
        return;
      }
    }

    // Build target URL
    const targetUrl = new URL(restPath, service.url);

    // Set CORS headers early (before proxying)
    this.setCorsHeaders(req, res);

    // Proxy request using http.request
    const proxyReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: this.buildProxyHeaders(req.headers),
      },
      (proxyRes) => {
        // Forward response status and headers
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (
            key.toLowerCase() !== "transfer-encoding" &&
            key.toLowerCase() !== "content-encoding" &&
            value
          ) {
            res.setHeader(key, value);
          }
        }

        res.writeHead(proxyRes.statusCode ?? 500);

        // Stream response body
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      console.error("Proxy request error:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      } else {
        res.destroy(err);
      }
    });

    // Pipe request body to proxy
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }

  /**
   * Build headers for the proxy request (excluding host).
   */
  private buildProxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const proxyHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "host" && value) {
        proxyHeaders[key] = value;
      }
    }
    return proxyHeaders;
  }

  /**
   * Set CORS headers on response if configured.
   */
  private setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const cors = this.options.cors;
    if (!cors) return;

    const origin = req.headers.origin;
    if (!origin) return;

    // Check if origin is allowed
    if (cors.origins.includes("*") || cors.origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      if (cors.credentials) {
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    }
  }
}
