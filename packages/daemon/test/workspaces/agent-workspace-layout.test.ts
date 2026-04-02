import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAgentWorkspaceLayout } from "../../src/workspaces/agent-workspace-layout";

describe("ensureAgentWorkspaceLayout", () => {
  let dir: string;
  let tmpl: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    tmpl = mkdtempSync(join(tmpdir(), "shoggoth-tpl-"));
    writeFileSync(join(tmpl, "AGENTS.md"), "from-tpl", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmpl, { recursive: true, force: true });
  });

  it("creates skills/memory and copies missing template files", () => {
    ensureAgentWorkspaceLayout(dir, { templateDir: tmpl });
    assert.ok(existsSync(join(dir, "skills")));
    assert.ok(existsSync(join(dir, "memory")));
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "from-tpl");
  });

  it("does not overwrite existing workspace markdown", () => {
    writeFileSync(join(dir, "AGENTS.md"), "original", "utf8");
    ensureAgentWorkspaceLayout(dir, { templateDir: tmpl });
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "original");
  });
});
