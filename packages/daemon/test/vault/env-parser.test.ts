import { describe, it, expect } from "vitest";
import { parseEnvFile } from "../../src/vault/env-parser";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("skips comments (lines starting with #)", () => {
    const result = parseEnvFile("# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux");
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("skips blank lines", () => {
    const result = parseEnvFile("FOO=bar\n\n   \nBAZ=qux");
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("splits on first = only (value can contain =)", () => {
    const result = parseEnvFile("DATABASE_URL=postgres://user:pass@host/db?option=value");
    expect(result).toEqual([
      { key: "DATABASE_URL", value: "postgres://user:pass@host/db?option=value" },
    ]);
  });

  it("strips optional surrounding double quotes", () => {
    const result = parseEnvFile('FOO="bar"');
    expect(result).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("strips optional surrounding single quotes", () => {
    const result = parseEnvFile("FOO='bar'");
    expect(result).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("handles empty values", () => {
    const result = parseEnvFile("EMPTY=\nFOO=bar");
    expect(result).toEqual([
      { key: "EMPTY", value: "" },
      { key: "FOO", value: "bar" },
    ]);
  });

  it("does not perform variable interpolation", () => {
    const result = parseEnvFile("FOO=$BAR\nBAZ=${QUX}");
    expect(result).toEqual([
      { key: "FOO", value: "$BAR" },
      { key: "BAZ", value: "${QUX}" },
    ]);
  });

  it("handles key= with no value after equals", () => {
    const result = parseEnvFile("FOO=");
    expect(result).toEqual([{ key: "FOO", value: "" }]);
  });

  it("handles keys with underscores and numbers", () => {
    const result = parseEnvFile("MY_KEY_123=value");
    expect(result).toEqual([{ key: "MY_KEY_123", value: "value" }]);
  });

  it("trims whitespace from keys but not values", () => {
    const result = parseEnvFile("  FOO  =bar");
    expect(result).toEqual([{ key: "FOO", value: "bar" }]);
  });
});