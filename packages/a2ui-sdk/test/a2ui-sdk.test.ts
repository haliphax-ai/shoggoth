import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");

describe("@shoggoth/a2ui-sdk", () => {
  it("should have a valid package.json", () => {
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(packageJson).toBeDefined();
    expect(packageJson.name).toBe("@shoggoth/a2ui-sdk");
  });

  it("should have correct package name format", () => {
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(packageJson.name).toMatch(/^@shoggoth\/a2ui-/);
  });

  it("should export from main entry point", async () => {
    // This import will fail if the package is not properly configured
    const pkg = await import("@shoggoth/a2ui-sdk");
    expect(pkg).toBeDefined();
  });
});
