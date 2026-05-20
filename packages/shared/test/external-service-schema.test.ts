import { describe, it, expect } from "vitest";
import {
  externalServiceDeclarationSchema,
  externalServiceHealthSchema,
  validateServiceIdConflicts,
} from "../src/schema";

describe("externalServiceHealthSchema", () => {
  it("parses TCP health check with optional port override", () => {
    const result = externalServiceHealthSchema.parse({
      kind: "tcp",
      port: 8080,
      timeoutMs: 3000,
    });
    expect(result.kind).toBe("tcp");
    expect(result.port).toBe(8080);
    expect(result.timeoutMs).toBe(3000);
  });

  it("parses TCP health check with defaults", () => {
    const result = externalServiceHealthSchema.parse({ kind: "tcp" });
    expect(result.kind).toBe("tcp");
    expect(result.port).toBeUndefined();
    expect(result.timeoutMs).toBe(5000);
  });

  it("parses HTTP health check with url, expectedStatus, timeoutMs", () => {
    const result = externalServiceHealthSchema.parse({
      kind: "http",
      url: "https://example.com/health",
      expectedStatus: 204,
      timeoutMs: 10000,
    });
    expect(result.kind).toBe("http");
    expect(result.url).toBe("https://example.com/health");
    expect(result.expectedStatus).toBe(204);
    expect(result.timeoutMs).toBe(10000);
  });

  it("parses HTTP health check with defaults", () => {
    const result = externalServiceHealthSchema.parse({
      kind: "http",
      url: "https://example.com/health",
    });
    expect(result.kind).toBe("http");
    expect(result.expectedStatus).toBe(200);
    expect(result.timeoutMs).toBe(5000);
  });

  it("fails for invalid health kind", () => {
    expect(() =>
      externalServiceHealthSchema.parse({
        kind: "invalid",
        url: "https://example.com",
      }),
    ).toThrow();
  });

  it("fails for invalid URL in HTTP health check", () => {
    expect(() =>
      externalServiceHealthSchema.parse({
        kind: "http",
        url: "not-a-url",
      }),
    ).toThrow();
  });

  it("fails for negative timeoutMs", () => {
    expect(() =>
      externalServiceHealthSchema.parse({
        kind: "tcp",
        timeoutMs: -1,
      }),
    ).toThrow();
  });

  it("fails for port out of range", () => {
    expect(() =>
      externalServiceHealthSchema.parse({
        kind: "tcp",
        port: 70000,
      }),
    ).toThrow();
  });
});

describe("externalServiceDeclarationSchema", () => {
  it("parses valid declaration successfully", () => {
    const result = externalServiceDeclarationSchema.parse({
      id: "my-service",
      label: "My Service",
      host: "localhost",
      port: 3000,
      protocol: "http",
      health: { kind: "tcp", port: 3000 },
    });
    expect(result.id).toBe("my-service");
    expect(result.label).toBe("My Service");
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(3000);
    expect(result.protocol).toBe("http");
  });

  it("applies default values correctly", () => {
    const result = externalServiceDeclarationSchema.parse({
      id: "my-service",
      host: "localhost",
      port: 3000,
      protocol: "http",
      health: { kind: "tcp" },
    });
    expect(result.basePath).toBe("/");
    expect(result.expose).toBe("direct");
    expect(result.manifestPath).toBe("/manifest");
    expect(result.healthIntervalMs).toBe(30000);
    expect(result.unhealthyThreshold).toBe(3);
  });

  it("parses with all optional fields", () => {
    const result = externalServiceDeclarationSchema.parse({
      id: "my-service",
      label: "My Service",
      host: "192.168.1.1",
      port: 8080,
      protocol: "http+ws",
      basePath: "/api",
      capabilities: ["chat", "files"],
      expose: "both",
      manifestPath: "/.well-known/service.json",
      health: { kind: "http", url: "https://example.com/health", expectedStatus: 200 },
      healthIntervalMs: 60000,
      unhealthyThreshold: 5,
    });
    expect(result.basePath).toBe("/api");
    expect(result.capabilities).toEqual(["chat", "files"]);
    expect(result.expose).toBe("both");
    expect(result.healthIntervalMs).toBe(60000);
    expect(result.unhealthyThreshold).toBe(5);
  });

  it("fails for missing required id", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for empty id", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for missing required host", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for missing required port", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        host: "localhost",
        protocol: "http",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for invalid protocol", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        host: "localhost",
        port: 3000,
        protocol: "ftp",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for port out of range", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        host: "localhost",
        port: 70000,
        protocol: "http",
        health: { kind: "tcp" },
      }),
    ).toThrow();
  });

  it("fails for negative healthIntervalMs", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
        healthIntervalMs: -1,
      }),
    ).toThrow();
  });

  it("fails for unknown field (strict mode)", () => {
    expect(() =>
      externalServiceDeclarationSchema.parse({
        id: "my-service",
        host: "localhost",
        port: 3000,
        protocol: "http",
        health: { kind: "tcp" },
        unknownField: "value",
      }),
    ).toThrow();
  });
});

describe("validateServiceIdConflicts", () => {
  it("returns empty array when no conflicts", () => {
    const errors = validateServiceIdConflicts({
      services: [
        {
          id: "service-1",
          host: "localhost",
          port: 3000,
          protocol: "http",
          health: { kind: "tcp" },
        },
        {
          id: "service-2",
          host: "localhost",
          port: 3001,
          protocol: "http",
          health: { kind: "tcp" },
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("catches duplicate service IDs in services array", () => {
    const errors = validateServiceIdConflicts({
      services: [
        {
          id: "my-service",
          host: "localhost",
          port: 3000,
          protocol: "http",
          health: { kind: "tcp" },
        },
        {
          id: "my-service",
          host: "localhost",
          port: 3001,
          protocol: "http",
          health: { kind: "tcp" },
        },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Duplicate service ID");
    expect(errors[0]).toContain("my-service");
  });

  it("returns empty array for empty services", () => {
    const errors = validateServiceIdConflicts({ services: [] });
    expect(errors).toEqual([]);
  });

  it("handles undefined services and processes", () => {
    const errors = validateServiceIdConflicts({});
    expect(errors).toEqual([]);
  });

  it("handles services with empty capabilities array", () => {
    const result = externalServiceDeclarationSchema.parse({
      id: "my-service",
      host: "localhost",
      port: 3000,
      protocol: "http",
      health: { kind: "tcp" },
      capabilities: [],
    });
    expect(result.capabilities).toEqual([]);
  });
});
