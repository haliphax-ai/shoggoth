import { describe, it, expect } from "vitest";
import {
  serviceDeclarationSchema,
  serviceToolDeclarationSchema,
  serviceManifestSchema,
  validateServicePortConflicts,
  processDeclarationSchema,
} from "@shoggoth/shared";

describe("serviceDeclarationSchema", () => {
  it("should parse a valid service block", () => {
    const result = serviceDeclarationSchema.parse({
      port: 3100,
      protocol: "http",
      basePath: "/",
      capabilities: ["canvas", "a2ui"],
      expose: "gateway",
      manifestPath: "/manifest",
      host: "127.0.0.1",
    });
    expect(result.port).toBe(3100);
    expect(result.protocol).toBe("http");
    expect(result.basePath).toBe("/");
    expect(result.capabilities).toEqual(["canvas", "a2ui"]);
    expect(result.expose).toBe("gateway");
    expect(result.manifestPath).toBe("/manifest");
    expect(result.host).toBe("127.0.0.1");
  });

  it("should apply default values", () => {
    const result = serviceDeclarationSchema.parse({
      port: 3100,
      protocol: "http",
    });
    expect(result.basePath).toBe("/");
    expect(result.expose).toBe("direct");
    expect(result.manifestPath).toBe("/manifest");
    expect(result.host).toBe("127.0.0.1");
  });

  it("should reject missing port", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        protocol: "http",
      }),
    ).toThrow();
  });

  it("should reject invalid protocol", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: 3100,
        protocol: "ftp",
      }),
    ).toThrow();
  });

  it("should reject port out of range (0)", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: 0,
        protocol: "http",
      }),
    ).toThrow();
  });

  it("should reject port out of range (>65535)", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: 65536,
        protocol: "http",
      }),
    ).toThrow();
  });

  it("should reject negative port", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: -1,
        protocol: "http",
      }),
    ).toThrow();
  });

  it("should reject non-integer port", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: 3100.5,
        protocol: "http",
      }),
    ).toThrow();
  });

  it("should accept ws protocol", () => {
    const result = serviceDeclarationSchema.parse({
      port: 3100,
      protocol: "ws",
    });
    expect(result.protocol).toBe("ws");
  });

  it("should accept http+ws protocol", () => {
    const result = serviceDeclarationSchema.parse({
      port: 3100,
      protocol: "http+ws",
    });
    expect(result.protocol).toBe("http+ws");
  });

  it("should reject unknown fields", () => {
    expect(() =>
      serviceDeclarationSchema.parse({
        port: 3100,
        protocol: "http",
        unknownField: "value",
      }),
    ).toThrow();
  });
});

describe("processDeclarationSchema with service", () => {
  it("should parse a process with a valid service block", () => {
    const result = processDeclarationSchema.parse({
      id: "canvas-web",
      label: "Canvas Web",
      startPolicy: "boot",
      command: "node",
      args: ["dist/server/index.js"],
      service: {
        port: 3100,
        protocol: "http",
        capabilities: ["canvas"],
      },
    });
    expect(result.id).toBe("canvas-web");
    expect(result.service).toBeDefined();
    expect(result.service?.port).toBe(3100);
  });

  it("should parse a process without a service block", () => {
    const result = processDeclarationSchema.parse({
      id: "my-process",
      startPolicy: "boot",
      command: "echo",
      args: ["hello"],
    });
    expect(result.service).toBeUndefined();
  });
});

describe("validateServicePortConflicts", () => {
  it("should throw for duplicate port+host", () => {
    const processes = [
      {
        id: "service-1",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
          host: "127.0.0.1",
        },
      },
      {
        id: "service-2",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
          host: "127.0.0.1",
        },
      },
    ];
    expect(() => validateServicePortConflicts(processes)).toThrow(/port.*conflict/i);
  });

  it("should allow same port on different hosts", () => {
    const processes = [
      {
        id: "service-1",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
          host: "127.0.0.1",
        },
      },
      {
        id: "service-2",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
          host: "0.0.0.0",
        },
      },
    ];
    // Should not throw
    validateServicePortConflicts(processes);
  });

  it("should allow same host on different ports", () => {
    const processes = [
      {
        id: "service-1",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
        },
      },
      {
        id: "service-2",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3101,
          protocol: "http" as const,
        },
      },
    ];
    // Should not throw
    validateServicePortConflicts(processes);
  });

  it("should ignore processes without service blocks", () => {
    const processes = [
      {
        id: "regular-process",
        startPolicy: "boot" as const,
        command: "echo",
        args: ["hello"],
      },
      {
        id: "service-1",
        startPolicy: "boot" as const,
        command: "node",
        service: {
          port: 3100,
          protocol: "http" as const,
        },
      },
    ];
    // Should not throw
    validateServicePortConflicts(processes);
  });
});

describe("serviceToolDeclarationSchema", () => {
  it("should parse a valid tool declaration", () => {
    const result = serviceToolDeclarationSchema.parse({
      name: "canvas.push",
      description: "Push an A2UI surface to the canvas",
      parameters: {
        type: "object",
        properties: {
          surface: { type: "string" },
        },
        required: ["surface"],
      },
      method: "POST",
      path: "/api/a2ui/push",
    });
    expect(result.name).toBe("canvas.push");
    expect(result.method).toBe("POST");
    expect(result.dispatch).toBe("body");
  });

  it("should apply default dispatch to 'body'", () => {
    const result = serviceToolDeclarationSchema.parse({
      name: "test.tool",
      description: "Test tool",
      parameters: {},
      method: "GET",
      path: "/test",
    });
    expect(result.dispatch).toBe("body");
  });

  it("should accept dispatch query", () => {
    const result = serviceToolDeclarationSchema.parse({
      name: "test.tool",
      description: "Test tool",
      parameters: {},
      method: "GET",
      path: "/test",
      dispatch: "query",
    });
    expect(result.dispatch).toBe("query");
  });

  it("should accept dispatch path", () => {
    const result = serviceToolDeclarationSchema.parse({
      name: "test.tool",
      description: "Test tool",
      parameters: {},
      method: "GET",
      path: "/test/:id",
      dispatch: "path",
    });
    expect(result.dispatch).toBe("path");
  });

  it("should reject missing name", () => {
    expect(() =>
      serviceToolDeclarationSchema.parse({
        description: "Test tool",
        parameters: {},
        method: "GET",
        path: "/test",
      }),
    ).toThrow();
  });

  it("should reject missing description", () => {
    expect(() =>
      serviceToolDeclarationSchema.parse({
        name: "test.tool",
        parameters: {},
        method: "GET",
        path: "/test",
      }),
    ).toThrow();
  });

  it("should reject missing method", () => {
    expect(() =>
      serviceToolDeclarationSchema.parse({
        name: "test.tool",
        description: "Test tool",
        parameters: {},
        path: "/test",
      }),
    ).toThrow();
  });

  it("should reject missing path", () => {
    expect(() =>
      serviceToolDeclarationSchema.parse({
        name: "test.tool",
        description: "Test tool",
        parameters: {},
        method: "GET",
      }),
    ).toThrow();
  });

  it("should accept valid dotted tool names", () => {
    const validNames = ["canvas.push", "a2ui.render", "test.tool_with_underscore"];
    for (const name of validNames) {
      const result = serviceToolDeclarationSchema.parse({
        name,
        description: "Test",
        parameters: {},
        method: "GET",
        path: "/test",
      });
      expect(result.name).toBe(name);
    }
  });
});

describe("serviceManifestSchema", () => {
  it("should parse a valid manifest", () => {
    const result = serviceManifestSchema.parse({
      name: "canvas-web",
      version: "1.0.0",
      tools: [
        {
          name: "canvas.push",
          description: "Push an A2UI surface",
          parameters: {},
          method: "POST",
          path: "/api/a2ui/push",
        },
      ],
      ops: ["turn.invoke"],
      wsEndpoints: [
        {
          path: "/ws",
          description: "WebSocket endpoint",
          protocol: "json",
        },
      ],
    });
    expect(result.name).toBe("canvas-web");
    expect(result.version).toBe("1.0.0");
    expect(result.tools).toHaveLength(1);
    expect(result.ops).toEqual(["turn.invoke"]);
    expect(result.wsEndpoints).toHaveLength(1);
  });

  it("should parse a minimal manifest", () => {
    const result = serviceManifestSchema.parse({
      name: "my-service",
      version: "1.0.0",
    });
    expect(result.name).toBe("my-service");
    expect(result.version).toBe("1.0.0");
    expect(result.tools).toBeUndefined();
    expect(result.ops).toBeUndefined();
  });

  it("should reject missing name", () => {
    expect(() =>
      serviceManifestSchema.parse({
        version: "1.0.0",
      }),
    ).toThrow();
  });

  it("should reject missing version", () => {
    expect(() =>
      serviceManifestSchema.parse({
        name: "my-service",
      }),
    ).toThrow();
  });

  it("should reject empty name", () => {
    expect(() =>
      serviceManifestSchema.parse({
        name: "",
        version: "1.0.0",
      }),
    ).toThrow();
  });

  it("should reject empty version", () => {
    expect(() =>
      serviceManifestSchema.parse({
        name: "my-service",
        version: "",
      }),
    ).toThrow();
  });
});
