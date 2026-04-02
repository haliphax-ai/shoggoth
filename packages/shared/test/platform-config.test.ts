import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveAgentDefaultPlatform } from "../src/platform-config";
import type { ShoggothConfig } from "../src/schema";

describe("resolveAgentDefaultPlatform", () => {
  it("returns the first platform key when agent has platform bindings", () => {
    const config = {
      agents: {
        list: {
          main: {
            platforms: {
              discord: { routes: [] },
            },
          },
        },
      },
    } as unknown as ShoggothConfig;
    assert.equal(resolveAgentDefaultPlatform(config, "main"), "discord");
  });

  it("returns undefined when agent has no platform bindings", () => {
    const config = {
      agents: {
        list: {
          main: {},
        },
      },
    } as unknown as ShoggothConfig;
    assert.equal(resolveAgentDefaultPlatform(config, "main"), undefined);
  });

  it("returns undefined when agent does not exist in config", () => {
    const config = {
      agents: {
        list: {},
      },
    } as unknown as ShoggothConfig;
    assert.equal(resolveAgentDefaultPlatform(config, "missing"), undefined);
  });

  it("returns undefined when agents.list is undefined", () => {
    const config = {} as unknown as ShoggothConfig;
    assert.equal(resolveAgentDefaultPlatform(config, "main"), undefined);
  });

  it("returns the first key when multiple platforms are configured", () => {
    const config = {
      agents: {
        list: {
          main: {
            platforms: {
              discord: { routes: [] },
              slack: { routes: [] },
            },
          },
        },
      },
    } as unknown as ShoggothConfig;
    const result = resolveAgentDefaultPlatform(config, "main");
    // Should return the first key
    assert.equal(result, "discord");
  });

  it("returns undefined when platforms object is empty", () => {
    const config = {
      agents: {
        list: {
          main: {
            platforms: {},
          },
        },
      },
    } as unknown as ShoggothConfig;
    assert.equal(resolveAgentDefaultPlatform(config, "main"), undefined);
  });
});
