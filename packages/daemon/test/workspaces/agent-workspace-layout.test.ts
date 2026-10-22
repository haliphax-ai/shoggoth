import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(tmpl, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("creates skills/memory and copies missing template files", async () => {
    const creds = {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
    await ensureAgentWorkspaceLayout(dir, creds, { templateDir: tmpl });
    assert.ok(existsSync(join(dir, "skills")));
    assert.ok(existsSync(join(dir, "memory")));
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "from-tpl");
  });

  it("creates media/inbound directory for attachment downloads", async () => {
    const creds = {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
    await ensureAgentWorkspaceLayout(dir, creds, { templateDir: tmpl });
    assert.ok(
      existsSync(join(dir, "media", "inbound")),
      "media/inbound directory should be created by ensureAgentWorkspaceLayout",
    );
  });

  it("does not overwrite existing workspace markdown", async () => {
    const creds = {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    };
    writeFileSync(join(dir, "AGENTS.md"), "original", "utf8");
    await ensureAgentWorkspaceLayout(dir, creds, { templateDir: tmpl });
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "original");
  });
});
describe("ensureAgentWorkspaceLayout directories and ACLs", () => {
  let dir: string;
  let tmpl: string;

  const hasSetfacl = (() => {
    if (process.platform !== "linux") return false;
    try {
      execFileSync("setfacl", ["--version"], { stdio: "ignore" });
      execFileSync("getfacl", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  const selfCreds = () => ({
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    tmpl = mkdtempSync(join(tmpdir(), "shoggoth-tpl-"));
    writeFileSync(join(tmpl, "AGENTS.md"), "from-tpl", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(tmpl, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("creates the prompts directory", async () => {
    await ensureAgentWorkspaceLayout(dir, selfCreds(), { templateDir: tmpl });
    assert.ok(
      existsSync(join(dir, "prompts")),
      "prompts directory should be created by ensureAgentWorkspaceLayout",
    );
  });

  it("creates the XDG directories used by xdgEnvForWorkspace", async () => {
    await ensureAgentWorkspaceLayout(dir, selfCreds(), { templateDir: tmpl });
    for (const d of [".config", ".local/share", ".local/state", ".cache"]) {
      assert.ok(existsSync(join(dir, d)), `${d} should exist`);
    }
  });

  it.skipIf(!hasSetfacl)(
    "installs default and access ACLs for the daemon uid on workspace directories",
    async () => {
      await ensureAgentWorkspaceLayout(dir, selfCreds(), { templateDir: tmpl });
      const uid = process.getuid?.();
      assert.ok(uid !== undefined, "requires POSIX uid");
      for (const d of [".", "skills", "prompts", "media/inbound"]) {
        const out = execFileSync("getfacl", ["-n", "-cp", join(dir, d)], {
          encoding: "utf8",
        });
        assert.match(
          out,
          new RegExp(`^user:${uid}:rwx$`, "m"),
          `access ACL for uid ${uid} missing on ${d}`,
        );
        assert.match(
          out,
          new RegExp(`^default:user:${uid}:rwx$`, "m"),
          `default ACL for uid ${uid} missing on ${d}`,
        );
      }
    },
  );

  it.skipIf(!hasSetfacl)(
    "default ACLs propagate to files and subdirectories created afterwards",
    async () => {
      await ensureAgentWorkspaceLayout(dir, selfCreds(), { templateDir: tmpl });
      const uid = process.getuid?.();
      assert.ok(uid !== undefined, "requires POSIX uid");
      const sub = join(dir, "memory");
      writeFileSync(join(sub, "log.md"), "entry", "utf8");
      mkdirSync(join(sub, "nested"), { recursive: true });
      const fileOut = execFileSync("getfacl", ["-n", "-cp", join(sub, "log.md")], {
        encoding: "utf8",
      });
      assert.match(
        fileOut,
        new RegExp(`^user:${uid}:`, "m"),
        `new file should inherit ACL for uid ${uid}`,
      );
      const dirOut = execFileSync("getfacl", ["-n", "-cp", join(sub, "nested")], {
        encoding: "utf8",
      });
      assert.match(
        dirOut,
        new RegExp(`^default:user:${uid}:rwx$`, "m"),
        `new subdirectory should inherit default ACL for uid ${uid}`,
      );
    },
  );
});
describe("ensureAgentWorkspaceLayout template file ACLs", () => {
  let dir: string;
  let tmpl: string;

  const hasSetfacl = (() => {
    if (process.platform !== "linux") return false;
    try {
      execFileSync("setfacl", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shoggoth-ws-"));
    tmpl = mkdtempSync(join(tmpdir(), "shoggoth-tpl-"));
    writeFileSync(join(tmpl, "AGENTS.md"), "from-tpl", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(tmpl, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it.skipIf(!hasSetfacl)(
    "copies template files with a daemon access ACL so the daemon can read them",
    async () => {
      const creds = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
      await ensureAgentWorkspaceLayout(dir, creds, { templateDir: tmpl });
      const uid = process.getuid?.();
      assert.ok(uid !== undefined, "requires POSIX uid");
      const out = execFileSync("getfacl", ["-n", "-cp", join(dir, "AGENTS.md")], {
        encoding: "utf8",
      });
      assert.match(
        out,
        new RegExp(`^user:${uid}:`, "m"),
        "copied template file should carry an access ACL for the daemon uid",
      );
    },
  );
});
