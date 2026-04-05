import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discordCapabilityDescriptor } from "@shoggoth/platform-discord";
import type { ContextLevel } from "@shoggoth/shared";
import { buildSessionSystemContext, TEMPLATE_FILES_BY_LEVEL } from "../../src/sessions/session-system-prompt";

describe("buildSessionSystemContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-prompt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes core sections without workspace", () => {
    const s = buildSessionSystemContext({
      workspacePath: undefined,
      env: { SHOGGOTH_MODEL: "test-model" },
      sessionId: "sid-1",
      channel: "discord",
      messagingCapabilities: discordCapabilityDescriptor(),
      toolNames: ["builtin-read", "builtin-exec"],
      systemContextToken: "test0001",
    });
    assert.match(s, /# System Context/);
    assert.match(s, /BEGIN TRUSTED SYSTEM CONTEXT/);
    assert.match(s, /## Workspace/);
    assert.match(s, /No workspace root/);
    assert.match(s, /## Runtime/);
    assert.match(s, /session=sid-1/);
    assert.match(s, /channel=discord/);
    assert.match(s, /model=test-model/);
  });

  it("injects operator GLOBAL.md before workspace AGENTS.md under Project Context", () => {
    const opDir = mkdtempSync(join(tmpdir(), "shoggoth-op-"));
    try {
      writeFileSync(join(opDir, "GLOBAL.md"), "operator-global-body");
      writeFileSync(join(dir, "AGENTS.md"), "agents-body");
      const s = buildSessionSystemContext({
        workspacePath: dir,
        config: { operatorDirectory: opDir } as unknown as import("@shoggoth/shared").ShoggothConfig,
        systemContextToken: "test0001",
      });
      assert.match(s, /## Global instructions \(operator-managed\)/);
      assert.match(s, /operator-global-body/);
      assert.match(s, /agents-body/);
      const g = s.indexOf("operator-global-body");
      const a = s.indexOf("--- workspace: AGENTS.md ---");
      assert.ok(g >= 0 && a >= 0 && g < a, "operator global precedes AGENTS block");
    } finally {
      rmSync(opDir, { recursive: true, force: true });
    }
  });

  it("respects SHOGGOTH_GLOBAL_INSTRUCTIONS_PATH under operator dir", () => {
    const opDir = mkdtempSync(join(tmpdir(), "shoggoth-op2-"));
    try {
      writeFileSync(join(opDir, "custom.md"), "from-env-path");
      const s = buildSessionSystemContext({
        workspacePath: undefined,
        env: { SHOGGOTH_GLOBAL_INSTRUCTIONS_PATH: join(opDir, "custom.md") },
        config: { operatorDirectory: opDir } as unknown as import("@shoggoth/shared").ShoggothConfig,
        systemContextToken: "test0001",
      });
      assert.match(s, /from-env-path/);
    } finally {
      rmSync(opDir, { recursive: true, force: true });
    }
  });

  it("skips operator global when path escapes operator directory (symlink)", () => {
    const opDir = mkdtempSync(join(tmpdir(), "shoggoth-op3-"));
    try {
      symlinkSync("/etc/passwd", join(opDir, "GLOBAL.md"));
      const s = buildSessionSystemContext({
        workspacePath: undefined,
        config: { operatorDirectory: opDir } as unknown as import("@shoggoth/shared").ShoggothConfig,
        systemContextToken: "test0001",
      });
      assert.doesNotMatch(s, /## Global instructions \(operator-managed\)/);
    } finally {
      rmSync(opDir, { recursive: true, force: true });
    }
  });

  it("ignores SOUL.md even when present in workspace", () => {
    writeFileSync(join(dir, "SOUL.md"), "persona: test");
    writeFileSync(join(dir, "AGENTS.md"), "do the thing");
    const s = buildSessionSystemContext({
      workspacePath: dir,
      sessionId: "s2",
      toolNames: [],
      systemContextToken: "test0001",
    });
    assert.doesNotMatch(s, /--- workspace: SOUL\.md ---/);
    assert.doesNotMatch(s, /persona: test/);
    assert.match(s, /--- workspace: AGENTS\.md ---/);
    assert.match(s, /do the thing/);
  });

  it("appends SHOGGOTH_SESSION_SYSTEM_PROMPT", () => {
    const s = buildSessionSystemContext({
      workspacePath: undefined,
      env: { SHOGGOTH_SESSION_SYSTEM_PROMPT: "extra operator note" },
      systemContextToken: "test0001",
    });
    assert.match(s, /--- session \(SHOGGOTH_SESSION_SYSTEM_PROMPT\) ---/);
    assert.match(s, /extra operator note/);
  });

  it("includes trusted system context guidance in every system prompt", () => {
    const s = buildSessionSystemContext({
      workspacePath: undefined,
      env: { SHOGGOTH_MODEL: "test-model" },
      sessionId: "sid-tsc",
      systemContextToken: "test0001",
    });
    // Section header and divider pattern
    assert.match(s, /# System Context/);
    assert.match(s, /--- BEGIN TRUSTED SYSTEM CONTEXT \[token:test0001\] ---/);
    assert.match(s, /--- END TRUSTED SYSTEM CONTEXT \[token:test0001\] ---/);
  });

  it("includes trusted system context guidance even with workspace files", () => {
    writeFileSync(join(dir, "AGENTS.md"), "agents-body");
    const s = buildSessionSystemContext({
      workspacePath: dir,
      sessionId: "sid-tsc-ws",
      toolNames: [],
      systemContextToken: "test0001",
    });
    assert.match(s, /# System Context/);
    assert.match(s, /--- BEGIN TRUSTED SYSTEM CONTEXT \[token:test0001\] ---/);
  });

  it("lists memory roots from config when set", () => {
    const s = buildSessionSystemContext({
      workspacePath: undefined,
      config: {
        memory: {
          paths: ["/data/memory"],
          embeddings: { enabled: false },
        },
      } as unknown as import("@shoggoth/shared").ShoggothConfig,
      systemContextToken: "test0001",
    });
    // memory.paths hint was removed in the system prompt cleanup
    assert.match(s, /# System Context/);
  });
});

// ---------------------------------------------------------------------------
// Context Level gating
// ---------------------------------------------------------------------------

describe("buildSessionSystemContext — context levels", () => {
  let dir: string;
  let opDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-ctx-"));
    opDir = mkdtempSync(join(tmpdir(), "shoggoth-ctx-op-"));
    // Populate workspace template files
    writeFileSync(join(dir, "AGENTS.md"), "agents-body");
    writeFileSync(join(dir, "TOOLS.md"), "tools-body");
    writeFileSync(join(dir, "IDENTITY.md"), "identity-body");
    writeFileSync(join(dir, "USER.md"), "user-body");
    writeFileSync(join(dir, "BOOTSTRAP.md"), "bootstrap-body");
    writeFileSync(join(dir, "MEMORY.md"), "memory-body");
    // Operator global
    writeFileSync(join(opDir, "GLOBAL.md"), "operator-global-body");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(opDir, { recursive: true, force: true });
  });

  function build(level: ContextLevel) {
    return buildSessionSystemContext({
      workspacePath: dir,
      contextLevel: level,
      config: {
        operatorDirectory: opDir,
        memory: { paths: ["/data/memory"], embeddings: { enabled: false } },
      } as unknown as import("@shoggoth/shared").ShoggothConfig,
      env: {
        SHOGGOTH_MODEL: "test-model",
        SHOGGOTH_SESSION_SYSTEM_PROMPT: "env-appendix-body",
      },
      sessionId: "sid-ctx",
      channel: "discord",
      messagingCapabilities: discordCapabilityDescriptor(),
      toolNames: ["builtin-read", "builtin-exec"],
      systemContextToken: "test0001",
    });
  }

  // -- none --

  it("none: returns empty string", () => {
    assert.strictEqual(build("none"), "");
  });

  // -- minimal --

  it("minimal: includes identity", () => {
    const s = build("minimal");
    assert.match(s, /# System Context/);
  });

  it("minimal: includes tooling", () => {
    const s = build("minimal");
    // Tooling section was removed; minimal just has system context + runtime
    assert.match(s, /# System Context/);
  });

  it("minimal: includes safety", () => {
    // Safety section was removed in cleanup
    assert.match(build("minimal"), /# System Context/);
  });

  it("minimal: includes trusted context", () => {
    assert.match(build("minimal"), /# System Context/);
    assert.match(build("minimal"), /BEGIN TRUSTED SYSTEM CONTEXT/);
  });

  it("minimal: includes runtime", () => {
    const s = build("minimal");
    assert.match(s, /## Runtime/);
    assert.match(s, /session=sid-ctx/);
  });

  it("minimal: excludes CLI & docs", () => {
    assert.doesNotMatch(build("minimal"), /## Shoggoth CLI and reference docs/);
  });

  it("minimal: excludes workspace root section", () => {
    assert.doesNotMatch(build("minimal"), /## Workspace/);
  });

  it("minimal: excludes operator global", () => {
    assert.doesNotMatch(build("minimal"), /operator-global-body/);
  });

  it("minimal: excludes all template files", () => {
    const s = build("minimal");
    assert.doesNotMatch(s, /--- workspace:/);
    assert.doesNotMatch(s, /agents-body/);
    assert.doesNotMatch(s, /tools-body/);
  });

  it("minimal: excludes heartbeats section", () => {
    assert.doesNotMatch(build("minimal"), /## Heartbeats/);
  });

  it("minimal: excludes silent replies", () => {
    assert.doesNotMatch(build("minimal"), /## Silent Replies/);
  });

  it("minimal: excludes memory hint", () => {
    assert.doesNotMatch(build("minimal"), /memory\.paths/);
  });

  it("minimal: excludes env appendix", () => {
    assert.doesNotMatch(build("minimal"), /env-appendix-body/);
  });

  // -- light --

  it("light: includes identity", () => {
    assert.match(build("light"), /# System Context/);
  });

  it("light: includes CLI & docs", () => {
    // CLI & docs section was removed in cleanup
    assert.match(build("light"), /# System Context/);
  });

  it("light: includes tooling", () => {
    // Tooling section was removed in cleanup
    assert.match(build("light"), /# System Context/);
  });

  it("light: includes safety", () => {
    // Safety section was removed in cleanup
    assert.match(build("light"), /# System Context/);
  });

  it("light: includes trusted context", () => {
    assert.match(build("light"), /# System Context/);
    assert.match(build("light"), /BEGIN TRUSTED SYSTEM CONTEXT/);
  });

  it("light: includes workspace root", () => {
    assert.match(build("light"), /## Workspace/);
  });

  it("light: includes operator global", () => {
    assert.match(build("light"), /operator-global-body/);
  });

  it("light: includes heartbeats", () => {
    // Heartbeats section was removed in cleanup
    assert.match(build("light"), /## Runtime/);
  });

  it("light: includes silent replies", () => {
    // Silent replies section was removed in cleanup
    assert.match(build("light"), /## Runtime/);
  });

  it("light: includes runtime", () => {
    assert.match(build("light"), /## Runtime/);
  });

  it("light: includes env appendix", () => {
    assert.match(build("light"), /env-appendix-body/);
  });

  it("light: includes filtered template files (AGENTS.md, TOOLS.md)", () => {
    const s = build("light");
    assert.match(s, /--- workspace: AGENTS\.md ---/);
    assert.match(s, /agents-body/);
    assert.match(s, /--- workspace: TOOLS\.md ---/);
    assert.match(s, /tools-body/);
  });

  it("light: excludes personality/bootstrap/memory/heartbeat template files", () => {
    const s = build("light");
    assert.doesNotMatch(s, /--- workspace: IDENTITY\.md ---/);
    assert.doesNotMatch(s, /--- workspace: USER\.md ---/);
    assert.doesNotMatch(s, /--- workspace: BOOTSTRAP\.md ---/);
    assert.doesNotMatch(s, /--- workspace: MEMORY\.md ---/);
    assert.doesNotMatch(s, /--- workspace: HEARTBEAT\.md ---/);
  });

  it("light: excludes memory hint", () => {
    assert.doesNotMatch(build("light"), /memory\.paths/);
  });

  // -- full --

  it("full: includes all core sections", () => {
    const s = build("full");
    assert.match(s, /# System Context/);
    assert.match(s, /BEGIN TRUSTED SYSTEM CONTEXT/);
    assert.match(s, /# Project Context/);
    assert.match(s, /## Runtime/);
  });

  it("full: when BOOTSTRAP.md is present, only BOOTSTRAP.md is injected", () => {
    const s = build("full");
    assert.match(s, /--- workspace: BOOTSTRAP\.md ---/);
    assert.match(s, /bootstrap-body/);
    assert.doesNotMatch(s, /--- workspace: AGENTS\.md ---/);
    assert.doesNotMatch(s, /--- workspace: TOOLS\.md ---/);
    assert.doesNotMatch(s, /--- workspace: IDENTITY\.md ---/);
    assert.doesNotMatch(s, /--- workspace: USER\.md ---/);
    assert.doesNotMatch(s, /--- workspace: HEARTBEAT\.md ---/);
    assert.doesNotMatch(s, /--- workspace: MEMORY\.md ---/);
  });

  it("full: when BOOTSTRAP.md is absent, all template files except SOUL.md are injected", () => {
    rmSync(join(dir, "BOOTSTRAP.md"), { force: true });
    const s = build("full");
    assert.match(s, /--- workspace: AGENTS\.md ---/);
    assert.match(s, /--- workspace: TOOLS\.md ---/);
    assert.match(s, /--- workspace: IDENTITY\.md ---/);
    assert.match(s, /--- workspace: USER\.md ---/);
    assert.match(s, /--- workspace: MEMORY\.md ---/);
    assert.doesNotMatch(s, /--- workspace: SOUL\.md ---/);
    assert.doesNotMatch(s, /--- workspace: BOOTSTRAP\.md ---/);
  });

  it("full: includes operator global", () => {
    assert.match(build("full"), /operator-global-body/);
  });

  it("full: includes memory hint", () => {
    // memory.paths hint was removed in cleanup
    assert.match(build("full"), /## Runtime/);
  });

  it("full: includes env appendix", () => {
    assert.match(build("full"), /env-appendix-body/);
  });

  // -- default behavior --

  it("defaults to full when contextLevel is omitted", () => {
    const withDefault = buildSessionSystemContext({
      workspacePath: dir,
      config: {
        operatorDirectory: opDir,
        memory: { paths: [], embeddings: { enabled: false } },
      } as unknown as import("@shoggoth/shared").ShoggothConfig,
      env: { SHOGGOTH_MODEL: "test-model" },
      sessionId: "sid-default",
      toolNames: [],
      systemContextToken: "test0001",
    });
    // Both should include all sections — check a few key markers
    assert.match(withDefault, /# System Context/);
    assert.match(withDefault, /## Runtime/);
    assert.match(withDefault, /--- workspace: BOOTSTRAP\.md ---/);
  });

  // -- TEMPLATE_FILES_BY_LEVEL constant --

  it("TEMPLATE_FILES_BY_LEVEL: none and minimal are empty", () => {
    assert.strictEqual(TEMPLATE_FILES_BY_LEVEL.none.size, 0);
    assert.strictEqual(TEMPLATE_FILES_BY_LEVEL.minimal.size, 1);
    assert.ok(TEMPLATE_FILES_BY_LEVEL.minimal.has("TOOLS.md"));
  });

  it("TEMPLATE_FILES_BY_LEVEL: light contains exactly AGENTS.md, TOOLS.md", () => {
    const light = TEMPLATE_FILES_BY_LEVEL.light;
    assert.strictEqual(light.size, 2);
    assert.ok(light.has("AGENTS.md"));
    assert.ok(light.has("TOOLS.md"));
  });

  it("TEMPLATE_FILES_BY_LEVEL: full contains all workspace template files", () => {
    const full = TEMPLATE_FILES_BY_LEVEL.full;
    assert.strictEqual(full.size, 6);
    for (const f of ["AGENTS.md", "TOOLS.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"]) {
      assert.ok(full.has(f), `full should contain ${f}`);
    }
  });
});
