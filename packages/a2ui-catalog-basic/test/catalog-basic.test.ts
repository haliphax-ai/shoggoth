import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");

describe("@shoggoth/a2ui-catalog-basic", () => {
  it("should have a valid package.json", () => {
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(packageJson).toBeDefined();
    expect(packageJson.name).toBe("@shoggoth/a2ui-catalog-basic");
  });

  it("should have correct package name format", () => {
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(packageJson.name).toMatch(/^@shoggoth\/a2ui-/);
  });

  it("should have catalog.json", () => {
    const catalogPath = join(packageDir, "catalog.json");
    expect(existsSync(catalogPath)).toBe(true);
  });

  it("catalog.json should reference shoggoth, not openclaw", () => {
    const catalogPath = join(packageDir, "catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

    const catalogString = JSON.stringify(catalog).toLowerCase();
    expect(catalogString).toContain("shoggoth");
    expect(catalogString).not.toContain("openclaw");
  });
});
