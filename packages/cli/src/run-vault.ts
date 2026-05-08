import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

/** Resolve a file path relative to the caller's cwd (not the process cwd). */
function resolveCallerPath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  const callerCwd = process.env.SHOGGOTH_CALLER_CWD || process.cwd();
  return resolve(callerCwd, filePath);
}

function controlAuth(): { kind: "operator_token"; token: string } {
  const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  if (!token) throw new Error("SHOGGOTH_OPERATOR_TOKEN is required");
  return { kind: "operator_token", token };
}

function socketPathFromEnv(configPath: string): string {
  const fromEnv = process.env.SHOGGOTH_CONTROL_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const config = loadLayeredConfig(configPath);
  return config.socketPath;
}

function printVaultHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth vault set <scope> <name> <value>   Store a credential
  shoggoth vault get <scope> <name>           Retrieve a credential
  shoggoth vault delete <scope> <name>        Remove a credential
  shoggoth vault list [scope]                 List credentials (all scopes if omitted)
  shoggoth vault import <scope> <file>        Bulk import from .env file
  shoggoth vault rotate-key [identity-file]   Re-encrypt all entries with new key (auto-generates if omitted)

Scopes: global, agent:<id>`);
}

export async function runVaultCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printVaultHelp();
    return;
  }
  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  const sub = argv[0];

  if (sub === "set") {
    const scope = argv[1]?.trim();
    const name = argv[2]?.trim();
    const value = argv[3];
    if (!scope || !name || value === undefined) {
      console.error("usage: shoggoth vault set <scope> <name> <value>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.set",
      payload: { scope, name, value },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "get") {
    const scope = argv[1]?.trim();
    const name = argv[2]?.trim();
    if (!scope || !name) {
      console.error("usage: shoggoth vault get <scope> <name>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.get",
      payload: { scope, name },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "delete") {
    const scope = argv[1]?.trim();
    const name = argv[2]?.trim();
    if (!scope || !name) {
      console.error("usage: shoggoth vault delete <scope> <name>");
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.delete",
      payload: { scope, name },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "list") {
    const scope = argv[1]?.trim();
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.list",
      payload: scope ? { scope } : {},
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === "import") {
    const scope = argv[1]?.trim();
    const filePath = argv[2]?.trim();
    if (!scope || !filePath) {
      console.error("usage: shoggoth vault import <scope> <file>");
      process.exitCode = 1;
      return;
    }
    let envFileContent: string;
    const resolvedPath = resolveCallerPath(filePath);
    try {
      envFileContent = readFileSync(resolvedPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to read file: ${resolvedPath}\n  ${msg}`);
      process.exitCode = 1;
      return;
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.import",
      payload: { scope, envFileContent },
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (sub === "rotate-key") {
    const identityFile = argv[1]?.trim() || undefined;
    const payload: Record<string, string> = {};
    if (identityFile) {
      payload.newIdentityPath = resolveCallerPath(identityFile);
    }
    const res = await invokeControlRequest({
      socketPath,
      auth,
      op: "vault.rotate-key",
      payload,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    if (!res.ok) process.exitCode = 1;
    return;
  }

  printVaultHelp();
  process.exitCode = 1;
}
