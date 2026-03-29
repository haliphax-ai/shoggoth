#!/usr/bin/env node
import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { formatSkillPathLine, formatSkillsListJson } from "./skills-cli";
import { runRetentionCli } from "./run-retention";
import { runEventsDlqCli } from "./run-events-dlq";
import { runSessionCompact } from "./run-session-compact";
import { runHitlCli } from "./run-hitl";
import { runMcpCli } from "./run-mcp";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-V")) {
  console.log(`shoggoth ${VERSION}`);
  process.exit(0);
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth --version | -V    Print version
  shoggoth config-show      Print effective layered config
  shoggoth retention run    Run retention jobs; JSON summary on stdout
  shoggoth events dlq       List dead-letter events; JSON on stdout
  shoggoth session compact <sessionId> [--force]  Summarize transcript in state DB; JSON on stdout
  shoggoth skills list      List skills from configured scan roots (JSON)
  shoggoth skills path <id> Print absolute path to skill markdown
  shoggoth hitl list [sessionId]   List pending HITL actions (JSON via control socket)
  shoggoth hitl get <id>           Fetch one pending row (JSON)
  shoggoth hitl approve <id>       Approve pending tool (JSON)
  shoggoth hitl deny <id>          Deny pending tool (JSON)
  shoggoth mcp cancel <sessionId> <sourceId> <requestId>  Cancel streamable HTTP MCP JSON-RPC id (JSON)
  Env: SHOGGOTH_CONTROL_SOCKET, SHOGGOTH_OPERATOR_TOKEN (non-Linux), SHOGGOTH_CONFIG_DIR`);
  process.exit(0);
}

const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

if (argv[0] === "config-show") {
  console.log(JSON.stringify(loadLayeredConfig(configDir), null, 2));
  process.exit(0);
}

if (argv[0] === "skills") {
  const config = loadLayeredConfig(configDir);
  if (argv[1] === "list") {
    process.stdout.write(formatSkillsListJson(config));
    process.exit(0);
  }
  if (argv[1] === "path") {
    const id = argv[2];
    if (!id) {
      console.error("usage: shoggoth skills path <id>");
      process.exit(1);
    }
    try {
      process.stdout.write(formatSkillPathLine(config, id));
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  console.error("usage: shoggoth skills list | shoggoth skills path <id>");
  process.exit(1);
}

if (argv[0] === "retention" && argv[1] === "run") {
  await runRetentionCli({ configDir });
  process.exit(0);
}

if (argv[0] === "events" && argv[1] === "dlq") {
  const limitRaw = argv[2];
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("usage: shoggoth events dlq [limit]");
    process.exit(1);
  }
  runEventsDlqCli({ configDir, limit });
  process.exit(0);
}

if (argv[0] === "hitl") {
  try {
    await runHitlCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

if (argv[0] === "mcp") {
  try {
    await runMcpCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

if (argv[0] === "session" && argv[1] === "compact") {
  const rest = argv.slice(2).filter((a) => a !== "--force");
  const sessionId = rest[0];
  const force = argv.includes("--force");
  if (!sessionId) {
    console.error("usage: shoggoth session compact <sessionId> [--force]");
    process.exit(1);
  }
  const config = loadLayeredConfig(configDir);
  const out = await runSessionCompact({
    stateDbPath: config.stateDbPath,
    models: config.models,
    sessionId,
    force,
  });
  console.log(JSON.stringify(out));
  process.exit(0);
}

console.error(`Unknown command. Try --help.`);
process.exit(1);
