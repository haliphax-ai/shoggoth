/**
 * SHOGGOTH-READY.md — static / in-repo verification (no Docker).
 * Maps to checklist sections where acceptance is documentation + unit-level behavior.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createPolicyEngine, redactToolArgsJson, DEFINED_CONTROL_OPS } from "@shoggoth/daemon/lib";
import { DEFAULT_POLICY_CONFIG } from "@shoggoth/shared";
import { discordCapabilityDescriptor } from "@shoggoth/platform-discord";
import { resolvePathForRead, AbsolutePathRejectedError } from "@shoggoth/os-exec";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDoc(rel) {
  return readFileSync(join(root, rel), "utf8");
}

describe("SHOGGOTH-READY §1 Deployment and trust (documentation)", () => {
  it("README documents Docker as the container runtime and filesystem layout", () => {
    const md = readDoc("README.md");
    assert.match(md, /Docker/i);
    assert.match(md, /\/var\/lib\/shoggoth/i);
    assert.match(md, /901/);
    assert.match(md, /`shoggoth`/i);
    const df = readDoc("Dockerfile");
    assert.match(df, /--uid\s+900|uid 900|UID 900/i);
  });

  it("RUNBOOK documents Docker-style layout and does not describe a public remote operator API", () => {
    const md = readDoc("docs/runbook.md");
    assert.match(md, /Docker/i);
    assert.match(md, /control.*socket|Unix/i);
    const lower = md.toLowerCase();
    assert.equal(
      lower.includes("public rest api") && lower.includes("operator"),
      false,
      "unexpected claim of public operator REST API",
    );
  });

  it("docker-compose.yml comments describe local CLI/socket trust boundary", () => {
    const yml = readDoc("docker-compose.yml");
    assert.match(yml, /shoggoth|socket|agent|901/i);
  });

  it("docker-compose.yml does not publish a remote operator TCP control port", () => {
    const yml = readDoc("docker-compose.yml");
    assert.equal(/ports:\s*\n\s*-\s*"[0-9]+:7777"/.test(yml), false);
  });

  it("readiness compose avoids empty-host env_file override pattern", () => {
    const yml = readDoc("tests/docker-compose.readiness.yml");
    assert.match(yml, /Avoid `\$\{VAR:-\}`/);
  });

  it("bootstrap-main-session creates workspace memory dir for agent memory tools", () => {
    const src = readDoc("scripts/bootstrap-main-session.mjs");
    assert.match(src, /join\(dir,\s*["']memory["']\)/);
    assert.match(src, /mkdirSync/);
  });

  it("entrypoint drops to shoggoth with setpriv; compose grants SETUID/SETGID for agent subprocess spawn", () => {
    const ep = readDoc("docker/entrypoint.sh");
    assert.match(ep, /setpriv/);
    assert.match(ep, /--reuid\s+shoggoth/);
    const df = readDoc("Dockerfile");
    assert.match(df, /shoggoth/);
    assert.match(df, /900/);
    assert.match(df, /\/usr\/local\/bin\/shoggoth/);
    const yml = readDoc("docker-compose.yml");
    assert.match(yml, /cap_add:/);
    assert.match(yml, /SETUID/);
    assert.match(yml, /SETGID/);
  });
});

describe("SHOGGOTH-READY §2 / §16 Policy, principals, audit fields", () => {
  it("policy engine enforces allow/deny for agent tool.invoke (per-tool rules)", () => {
    const cfg = structuredClone(DEFAULT_POLICY_CONFIG);
    cfg.agent.tools = { allow: ["builtin.read"], deny: ["builtin.write"] };
    const eng = createPolicyEngine(cfg);
    const agent = { kind: "agent", sessionId: "s1", source: "agent" };
    assert.equal(
      eng.check({
        principal: agent,
        action: "tool.invoke",
        resource: "builtin.read",
      }).allow,
      true,
    );
    const denied = eng.check({
      principal: agent,
      action: "tool.invoke",
      resource: "builtin.write",
    });
    assert.equal(denied.allow, false);
  });

  it("operator and agent control paths use the same DEFINED_CONTROL_OPS vocabulary", () => {
    assert.ok(DEFINED_CONTROL_OPS.includes("hitl_pending_list"));
    assert.ok(DEFINED_CONTROL_OPS.includes("hitl_clear"));
    assert.ok(DEFINED_CONTROL_OPS.includes("health"));
    assert.ok(DEFINED_CONTROL_OPS.includes("subagent_spawn"));
    assert.ok(DEFINED_CONTROL_OPS.includes("session_list"));
    assert.ok(DEFINED_CONTROL_OPS.includes("session_send"));
    assert.ok(DEFINED_CONTROL_OPS.includes("session_abort"));
  });
});

describe("SHOGGOTH-READY §3 Workspace path enforcement (application layer)", () => {
  it("rejects absolute paths before subprocess (workspace boundary)", () => {
    assert.throws(
      () => resolvePathForRead("/tmp/ws", "/etc/passwd"),
      AbsolutePathRejectedError,
    );
  });
});

describe("SHOGGOTH-READY §4 Secrets (documentation)", () => {
  it("operator-secrets.md documents Compose secrets and agent UID isolation", () => {
    const md = readDoc("docs/operator-secrets.md");
    assert.match(md, /\/run\/secrets/);
    assert.match(md, /901|agent/i);
  });
});

describe("SHOGGOTH-READY §9 Capability negotiation (Discord adapter)", () => {
  it("exports a structured capability descriptor", () => {
    const cap = discordCapabilityDescriptor();
    assert.ok(cap && typeof cap === "object");
  });
});

describe("SHOGGOTH-READY §11 / §16 Memory + audit redaction helpers", () => {
  it("redacts sensitive json paths per default policy hints", () => {
    const paths = DEFAULT_POLICY_CONFIG.auditRedaction?.jsonPaths ?? [];
    const out = redactToolArgsJson(JSON.stringify({ password: "secret", ok: true }), paths);
    const parsed = JSON.parse(out);
    assert.notEqual(parsed.password, "secret");
    assert.equal(parsed.ok, true);
  });
});

describe("SHOGGOTH-READY §15 Migrations present in repo", () => {
  it("lists numbered SQL migrations under shoggoth/migrations", () => {
    const dir = join(root, "migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    assert.ok(sql.length >= 1);
    for (const f of sql) assert.match(f, /^\d{4}_.+\.sql$/);
  });
});

describe("SHOGGOTH-READY — explicit deferrals (sanity)", () => {
  it("unit tests exist for HITL, events queue, and control plane (deeper coverage)", () => {
    const daemonTest = join(root, "packages/daemon/test");
    const hitl = readdirSync(join(daemonTest, "hitl"));
    assert.ok(hitl.some((f) => f.endsWith(".test.ts")));
    const events = readdirSync(join(daemonTest, "events"));
    assert.ok(events.some((f) => f.endsWith(".test.ts")));
    const control = readdirSync(join(daemonTest, "control"));
    assert.ok(control.some((f) => f.endsWith(".test.ts")));
  });
});
