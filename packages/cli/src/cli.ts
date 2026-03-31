#!/usr/bin/env node
import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { formatSkillPathLine, formatSkillReadJson, formatSkillsListJson } from "./skills-cli";
import { runRetentionCli } from "./run-retention";
import { runEventsDlqCli } from "./run-events-dlq";
import { runSessionCli } from "./run-session";
import { runHitlCli } from "./run-hitl";
import { runMcpCli } from "./run-mcp";
import { runSubagentCli } from "./run-subagent";
import { runSystemCli } from "./run-system";
import { runProcmanCli } from "./run-procman";
import { printConfigHelp, runConfigShow } from "./run-config";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-V")) {
  console.log(`shoggoth ${VERSION}`);
  process.exit(0);
}

function printTopLevelHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth --version | -V         Print version
  shoggoth --help | -h            Top-level commands (this text)
  shoggoth config                 Layered config (see: shoggoth config --help)
  shoggoth session                Sessions and transcripts (see: shoggoth session --help)
  shoggoth subagent               Subagent spawn (see: shoggoth subagent --help)
  shoggoth retention              Data retention (see: shoggoth retention --help)
  shoggoth events                 Event tooling (see: shoggoth events --help)
  shoggoth skills                 Skill discovery (see: shoggoth skills --help)
  shoggoth hitl                   HITL queue / clear (see: shoggoth hitl --help)
  shoggoth mcp                    MCP helpers (see: shoggoth mcp --help)
  shoggoth system               System operations (see: shoggoth system --help)
  shoggoth procman              Process manager (see: shoggoth procman --help)

Env: SHOGGOTH_CONTROL_SOCKET, SHOGGOTH_OPERATOR_TOKEN (non-Linux), SHOGGOTH_CONFIG_DIR`);
}

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  printTopLevelHelp();
  process.exit(0);
}

const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;

if (argv[0] === "config-show") {
  console.error("unknown command: config-show (use: shoggoth config show)");
  process.exit(1);
}

if (argv[0] === "config") {
  const rest = argv.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printConfigHelp(VERSION);
    process.exit(0);
  }
  if (rest[0] === "show") {
    await runConfigShow();
    process.exit(0);
  }
  console.error("usage: shoggoth config show");
  process.exit(1);
}

if (argv[0] === "skills") {
  const rest = argv.slice(1);
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    console.log(`shoggoth ${VERSION}
Usage:
  shoggoth skills list        List skills from configured scan roots (JSON)
  shoggoth skills path <id>   Print absolute path to skill markdown
  shoggoth skills read <id>   Print skill path and contents (JSON)`);
    process.exit(0);
  }
  const config = loadLayeredConfig(configDir);
  if (rest[0] === "list") {
    process.stdout.write(formatSkillsListJson(config));
    process.exit(0);
  }
  if (rest[0] === "path") {
    const id = rest[1];
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
  if (rest[0] === "read") {
    const id = rest[1];
    if (!id) {
      console.error("usage: shoggoth skills read <id>");
      process.exit(1);
    }
    try {
      process.stdout.write(formatSkillReadJson(config, id));
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
  console.error("usage: shoggoth skills list | shoggoth skills path <id> | shoggoth skills read <id>");
  process.exit(1);
}

if (argv[0] === "retention") {
  if (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h") {
    console.log(`usage: shoggoth retention run`);
    process.exit(0);
  }
  if (argv[1] === "run") {
    await runRetentionCli({ configDir });
    process.exit(0);
  }
  console.error("usage: shoggoth retention run");
  process.exit(1);
}

if (argv[0] === "events") {
  if (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h") {
    console.log(`usage: shoggoth events dlq [limit]`);
    process.exit(0);
  }
  if (argv[1] === "dlq") {
    const limitRaw = argv[2];
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("usage: shoggoth events dlq [limit]");
      process.exit(1);
    }
    runEventsDlqCli({ configDir, limit });
    process.exit(0);
  }
  console.error("usage: shoggoth events dlq [limit]");
  process.exit(1);
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

if (argv[0] === "subagent") {
  try {
    await runSubagentCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

if (argv[0] === "session") {
  try {
    await runSessionCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

if (argv[0] === "procman") {
  try {
    await runProcmanCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

if (argv[0] === "system") {
  try {
    await runSystemCli(argv.slice(1));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(process.exitCode ?? 0);
}

console.error(`Unknown command. Try shoggoth --help.`);
process.exit(1);
