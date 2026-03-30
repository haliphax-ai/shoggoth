/**
 * SHOGGOTH-READY.md checklist — Docker Compose integration harness.
 *
 * Prerequisites:
 *   - docker + compose v2
 *   - Prefer repo `.env.shoggoth.local` (copy `.env.shoggoth.example`): Shoggoth’s Discord bot + model API vars.
 *   - Optional override: `tests/.env.readiness.local` (gitignored).
 *   - Inside the container, `ANTHROPIC_*` / `OPENAI_*` must reach your API (e.g. a server on the Docker host).
 *   - Optional extra compose fragment: `SHOGGOTH_EXTRA_COMPOSE_FILE` (path). CI uses `docker-compose.yml` + `tests/docker-compose.readiness.yml` only.
 *
 * Cooperative Discord E2E (§13): set SHOGGOTH_READINESS_COOPERATIVE_E2E=1; human user 347033761822801922.
 * Default channel is <#1487579255616573533>; override with SHOGGOTH_READINESS_DISCORD_CHANNEL_ID for #developer, etc.
 * The harness posts a bot message in that channel with instructions unless
 * SHOGGOTH_READINESS_COOPERATIVE_SKIP_CHANNEL_PROMPT=1. Only messages **after** that post count (no stale triggers).
 * Optional: SHOGGOTH_READINESS_COOPERATIVE_TRIGGER=preset substring to show in the prompt and to match.
 *
 * Skip everything heavy: SKIP_SHOGGOTH_READINESS=1
 *
 * Docker socket access: if the user is in group `docker` but this process does not yet have the
 * supplementary group (e.g. no re-login after usermod), plain `docker` may get "permission denied".
 * This harness falls back to `sg docker -c 'docker …'` when needed.
 */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import { readinessGuildSessionUrn } from "@shoggoth/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readinessGuildSessionId = readinessGuildSessionUrn("readiness");
const extraCompose = process.env.SHOGGOTH_EXTRA_COMPOSE_FILE?.trim();
const extraComposePath = extraCompose
  ? extraCompose.startsWith("/")
    ? extraCompose
    : join(root, extraCompose)
  : "";
const composeBase = [
  "compose",
  "-f",
  "docker-compose.yml",
  ...(extraCompose ? ["-f", extraComposePath] : []),
  "-f",
  "tests/docker-compose.readiness.yml",
];

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}

loadEnvFile(join(root, "tests/.env.readiness.local"));
loadEnvFile(join(root, ".env.shoggoth.local"));

if (!process.env.SHOGGOTH_OPERATOR_TOKEN?.trim()) {
  process.env.SHOGGOTH_OPERATOR_TOKEN = "readiness-ci-token";
}

/** Cooperative §13 + compose Discord routes: <#1487579255616573533> (guild 695327822306345040). */
const READINESS_COOPERATIVE_CHANNEL_ID = "1487579255616573533";
const readinessDiscordChannelId =
  process.env.SHOGGOTH_READINESS_DISCORD_CHANNEL_ID?.trim() || READINESS_COOPERATIVE_CHANNEL_ID;

const readinessEnv = () => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "shoggoth-readiness",
});

/** POSIX shell-escape for use inside `sg docker -c '…'`. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

let dockerModeCache;
/** @returns {"direct" | "sg" | null} */
function getDockerMode() {
  if (dockerModeCache !== undefined) return dockerModeCache;
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) {
    dockerModeCache = "direct";
  } else if (spawnSync("sg", ["docker", "-c", "docker info"], { stdio: "ignore" }).status === 0) {
    dockerModeCache = "sg";
  } else {
    dockerModeCache = null;
  }
  return dockerModeCache;
}

function runDocker(argv, opts = {}) {
  const mode = getDockerMode();
  if (mode === null) throw new Error("docker unavailable (no socket access via docker or sg docker)");
  const merged = { cwd: root, ...opts, env: opts.env ?? readinessEnv() };
  if (mode === "direct") {
    return execFileSync("docker", argv, merged);
  }
  const cmd = `docker ${argv.map(shQuote).join(" ")}`;
  return execFileSync("sg", ["docker", "-c", cmd], merged);
}

function spawnDocker(argv, opts = {}) {
  const mode = getDockerMode();
  if (mode === null) throw new Error("docker unavailable (no socket access via docker or sg docker)");
  const merged = { cwd: root, ...opts, env: opts.env ?? readinessEnv() };
  if (mode === "direct") {
    return spawnSync("docker", argv, merged);
  }
  const cmd = `docker ${argv.map(shQuote).join(" ")}`;
  return spawnSync("sg", ["docker", "-c", cmd], merged);
}

function dockerCompose(args, inheritIo = false) {
  return runDocker([...composeBase, ...args], {
    stdio: inheritIo ? "inherit" : ["pipe", "pipe", "pipe"],
    encoding: inheritIo ? undefined : "utf8",
  });
}

function dockerComposeSpawn(args) {
  return spawnDocker([...composeBase, ...args], {
    encoding: "utf8",
  });
}

/** True when Docker daemon + compose plugin are usable (direct or via `sg docker`). */
function hasDockerComposeAvailable() {
  const mode = getDockerMode();
  if (mode === null) return false;
  if (mode === "direct") {
    return spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sg", ["docker", "-c", "docker compose version"], { stdio: "ignore" }).status === 0;
}

function execInShoggoth(user, scriptRel, inherit = false) {
  const cmd = [
    ...composeBase,
    "exec",
    "-T",
    "-u",
    user,
    "-w",
    "/app",
    "shoggoth",
    "node",
    "--import",
    "tsx/esm",
    scriptRel,
  ];
  return runDocker(cmd, {
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    encoding: inherit ? undefined : "utf8",
  });
}

/** Control-plane health: SQLite reachable (state DB + migrations). Model/Discord may still warn/fail. */
function healthSnapshotFromExec() {
  const out = execInShoggoth("shoggoth", "tests/scripts/control-health.mjs");
  return JSON.parse(out);
}

function sqliteCheckPass(j) {
  return j.checks?.find((c) => c.name === "sqlite")?.status === "pass";
}

// --- Compose stack --- (§1 docs live in tests/readiness-static.test.mjs)
const skipHeavy = process.env.SKIP_SHOGGOTH_READINESS === "1" || !hasDockerComposeAvailable();

describe(
  "SHOGGOTH-READY — docker compose stack",
  { skip: skipHeavy, concurrency: false },
  () => {
    before(async () => {
      const env = { ...readinessEnv() };
      const token = process.env.DISCORD_BOT_TOKEN?.trim();
      if (token) {
        const { buildDiscordRoutesJson } = await import("./scripts/discord-api.mjs");
        env.SHOGGOTH_DISCORD_ROUTES = await buildDiscordRoutesJson(token, {
          guildId: "695327822306345040",
          channelId: readinessDiscordChannelId,
          dmUserId: "347033761822801922",
          includeDm: true,
        });
      } else {
        env.SHOGGOTH_DISCORD_ROUTES = "[]";
      }
      const buildArgs = [...composeBase, "build"];
      if (process.env.SHOGGOTH_READINESS_NO_CACHE === "1") buildArgs.push("--no-cache");
      runDocker(buildArgs, { stdio: "inherit", env });
      runDocker([...composeBase, "up", "-d"], { stdio: "inherit", env });

      const deadline = Date.now() + 120_000;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          const j = healthSnapshotFromExec();
          if (sqliteCheckPass(j)) return;
          lastErr = `sqlite not pass yet: ${JSON.stringify(j.checks?.find((c) => c.name === "sqlite"))}`;
        } catch (e) {
          lastErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`daemon did not become healthy: ${lastErr}`);
    });

    after(() => {
      try {
        dockerCompose(["down", "-v"], true);
      } catch {
        /* best-effort */
      }
    });

    it("§1 acceptance: container running", () => {
      const ps = dockerCompose(["ps"]);
      assert.match(ps, /shoggoth|Up|running/i);
    });

    it("§2.2 / §3 / §4: control socket exists; state dir not readable by agent UID 901", () => {
      const statSock = dockerComposeSpawn([
        "exec",
        "-T",
        "shoggoth",
        "sh",
        "-c",
        "test -S /run/shoggoth/control.sock && echo ok",
      ]);
      assert.equal(statSock.stdout.trim(), "ok");

      const leak = dockerComposeSpawn([
        "exec",
        "-T",
        "-u",
        "901",
        "shoggoth",
        "sh",
        "-c",
        "cat /var/lib/shoggoth/state/shoggoth.db 2>&1 || true",
      ]);
      const out = `${leak.stdout}${leak.stderr}`;
      assert.match(out, /Permission denied|cannot open|denied/i);
    });

    it("§2.2: SO_PEERCRED path — health via control-health.mjs as shoggoth", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/control-health.mjs");
      const j = JSON.parse(out);
      assert.equal(typeof j.ready, "boolean");
      assert.ok(Array.isArray(j.checks));
      const names = j.checks.map((c) => c.name);
      assert.ok(names.some((n) => /sqlite|database/i.test(String(n))));
    });

    it("§2.3: operator_token ping (daemon + CLI share compose SHOGGOTH_OPERATOR_TOKEN default)", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/operator-token-ping.mjs");
      assert.match(out, /pong|"pong":\s*true/);
    });

    it("§5 bootstrap: fixed Discord session rows + workspace trees", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/bootstrap-sessions.mjs");
      const j = JSON.parse(out);
      assert.equal(j.ok, true);
      assert.ok(j.sessions.includes(readinessGuildSessionId));
    });

    it("§15: migrated SQLite schema includes core tables", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/sqlite-schema-probe.mjs");
      const j = JSON.parse(out);
      assert.equal(j.ok, true);
    });

    it("§2.2: CLI hitl list over socket (operator peercred)", () => {
      const out = runDocker(
        [
          ...composeBase,
          "exec",
          "-T",
          "-u",
          "shoggoth",
          "-w",
          "/app",
          "shoggoth",
          "node",
          "--import",
          "tsx/esm",
          "packages/cli/src/cli.ts",
          "hitl",
          "list",
        ],
        { encoding: "utf8" },
      );
      const j = JSON.parse(out.trim());
      assert.equal(j.ok, true);
    });

    it("§8: skills list JSON from CLI (readiness fixture scan root)", () => {
      const out = runDocker(
        [...composeBase, "exec", "-T", "-u", "shoggoth", "-w", "/app", "shoggoth", "node", "--import", "tsx/esm", "packages/cli/src/cli.ts", "skills", "list"],
        { encoding: "utf8" },
      );
      const arr = JSON.parse(out.trim());
      assert.ok(Array.isArray(arr));
      assert.ok(
        arr.some(
          (s) => String(s.id || "").includes("readiness") || String(s.path || "").includes("readiness"),
        ),
      );
    });

    it("§11: memory ingest + BM25/FTS hit for fixture markdown", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/memory-smoke.mjs");
      const j = JSON.parse(out);
      assert.ok(j.hitCount >= 1);
    });

    it("§6 / §15: retention CLI runs (may delete nothing)", () => {
      const out = runDocker(
        [...composeBase, "exec", "-T", "-u", "shoggoth", "-w", "/app", "shoggoth", "node", "--import", "tsx/esm", "packages/cli/src/cli.ts", "retention", "run"],
        { encoding: "utf8" },
      );
      const j = JSON.parse(out.trim());
      assert.ok(typeof j === "object");
    });

    it("§6: events DLQ CLI returns JSON array", () => {
      const out = runDocker(
        [
          ...composeBase,
          "exec",
          "-T",
          "-u",
          "shoggoth",
          "-w",
          "/app",
          "shoggoth",
          "node",
          "--import",
          "tsx/esm",
          "packages/cli/src/cli.ts",
          "events",
          "dlq",
          "10",
        ],
        { encoding: "utf8" },
      );
      const j = JSON.parse(out.trim());
      assert.ok(Array.isArray(j.dead));
    });

    it("§4: /run/secrets is root-owned 0700 in the image", () => {
      const r = dockerComposeSpawn(["exec", "-T", "shoggoth", "stat", "-c", "%U %G %a", "/run/secrets"]);
      assert.equal(`${r.stdout}`.trim(), "root root 700");
    });

    it("§9: Discord capability descriptor is structured JSON", () => {
      const out = execInShoggoth("shoggoth", "tests/scripts/capabilities-smoke.mjs");
      const j = JSON.parse(out);
      assert.ok(j && typeof j === "object");
      assert.equal(j.platform, "discord");
      assert.ok(j.supports?.markdown === true || j.extensions?.streamingOutbound === true);
    });

    it("§12: session compact CLI returns JSON for readiness guild session URN", async () => {
      const out = runDocker(
        [
          ...composeBase,
          "exec",
          "-T",
          "-u",
          "shoggoth",
          "-w",
          "/app",
          "shoggoth",
          "node",
          "--import",
          "tsx/esm",
          "packages/cli/src/cli.ts",
          "session",
          "compact",
          readinessGuildSessionId,
        ],
        { encoding: "utf8" },
      );
      const j = JSON.parse(out.trim());
      assert.ok("compacted" in j && "messageCount" in j);
    });

    it("§5: daemon restart preserves SQLite schema", async () => {
      dockerCompose(["restart", "shoggoth"]);
      const deadline = Date.now() + 90_000;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          if (sqliteCheckPass(healthSnapshotFromExec())) {
            lastErr = "";
            break;
          }
          lastErr = "sqlite check not pass";
        } catch (e) {
          lastErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (lastErr) throw new Error(`daemon not healthy after restart: ${lastErr}`);
      const out = execInShoggoth("shoggoth", "tests/scripts/sqlite-schema-probe.mjs");
      const j = JSON.parse(out);
      assert.equal(j.ok, true);
    });
  },
);

describe(
  "SHOGGOTH-READY §13 — cooperative Discord platform round-trip (guild channel)",
  {
    skip: skipHeavy || process.env.SHOGGOTH_READINESS_COOPERATIVE_E2E !== "1",
    concurrency: false,
  },
  () => {
    before(async () => {
      const token = process.env.DISCORD_BOT_TOKEN?.trim();
      assert.ok(token, "DISCORD_BOT_TOKEN required");
      const { buildDiscordRoutesJson } = await import("./scripts/discord-api.mjs");
      const env = { ...readinessEnv() };
      env.SHOGGOTH_DISCORD_ROUTES = await buildDiscordRoutesJson(token, {
        channelId: readinessDiscordChannelId,
      });
      const bArgs = [...composeBase, "build"];
      if (process.env.SHOGGOTH_READINESS_NO_CACHE === "1") bArgs.push("--no-cache");
      runDocker(bArgs, { stdio: "inherit", env });
      runDocker([...composeBase, "up", "-d"], { stdio: "inherit", env });
      const deadline = Date.now() + 120_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          if (sqliteCheckPass(healthSnapshotFromExec())) {
            healthy = true;
            break;
          }
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!healthy) throw new Error("cooperative suite: daemon not healthy within timeout");
      execInShoggoth("shoggoth", "tests/scripts/bootstrap-sessions.mjs");
    });

    after(() => {
      try {
        dockerCompose(["down", "-v"], true);
      } catch {
        /* ignore */
      }
    });

    it("user posts trigger then bot replies in channel", async () => {
      const token = process.env.DISCORD_BOT_TOKEN?.trim();
      const { getBotUserId, waitForCooperativeRoundTrip, postChannelMessage } = await import(
        "./scripts/discord-api.mjs",
      );
      const channelId = readinessDiscordChannelId;
      const userId = "347033761822801922";
      const botId = await getBotUserId(token);
      const preset = process.env.SHOGGOTH_READINESS_COOPERATIVE_TRIGGER?.trim();
      const trigger =
        preset && preset.length > 0 ? preset : `shoggoth-readiness-${randomUUID().slice(0, 8)}`;
      const skipChannelPrompt = process.env.SHOGGOTH_READINESS_COOPERATIVE_SKIP_CHANNEL_PROMPT === "1";
      const promptBody = [
        "**Shoggoth readiness §13 (cooperative)**",
        `<@${userId}> Reply in this channel with a message that contains: \`${trigger}\``,
        "The **readiness Docker** bot should answer **after** your message (keep `npm run test:readiness` / compose running until this step completes).",
      ].join("\n");

      let waiterOpts = {};
      if (!skipChannelPrompt) {
        const posted = await postChannelMessage(token, channelId, promptBody);
        waiterOpts = { afterMessageId: posted.id };
      }
      console.log(
        `\n>>> Cooperative E2E: channel prompt ${skipChannelPrompt ? "skipped (stdout only)" : "posted"} to <#${channelId}>; trigger substring: ${trigger}\n`,
      );

      const { botMessage } = await waitForCooperativeRoundTrip(
        token,
        channelId,
        userId,
        botId,
        trigger,
        180_000,
        waiterOpts,
      );
      assert.ok(botMessage.content.trim().length > 0);
    });
  },
);

describe("SHOGGOTH-READY — manual / out-of-band notes", () => {
  it("documents deferred items not automated here", () => {
    assert.ok(true);
    /* §3 kernel DAC integration tests: npm run test:ci-agent-isolation as root with uid 901.
       §7 full health failure injection: stop dependencies manually.
       §14 full HITL queue + approve: covered in @shoggoth/daemon unit tests; compose hitl list smoke above.
       §9 ACP/canvas full E2E: see docs/canvas.md and mcp-transport.md. */
  });
});
