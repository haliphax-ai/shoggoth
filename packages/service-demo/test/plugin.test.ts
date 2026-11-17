import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { request } from "node:http";
import { startServer } from "../src/plugin.js";

interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/** Minimal HTTP request helper returning raw status/headers/body text. */
function makeRequest(port: number, method: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const req = request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            "content-type": res.headers["content-type"] as string | undefined,
            allow: res.headers.allow as string | undefined,
          },
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("plugin mode HTTP server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the HTML page on GET /", async () => {
    const res = await makeRequest(port, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<h1>Demo Service</h1>");
  });

  it("returns 405 for non-GET requests to /", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await makeRequest(port, method, "/");
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET");
      expect(JSON.parse(res.body)).toEqual({ error: "method not allowed" });
    }
  });

  it("returns 404 for non-root paths", async () => {
    const res = await makeRequest(port, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });
});
