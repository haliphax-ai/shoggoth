import { readFileSync } from "node:fs";
import type { ShoggothConfig } from "@shoggoth/shared";

/**
 * Operator token secret: config file path wins over `SHOGGOTH_OPERATOR_TOKEN` env.
 * Trimmed of leading/trailing whitespace and BOM-newline typical of secret mounts.
 */
export function readOperatorTokenSecret(config: ShoggothConfig): string | undefined {
  if (config.operatorTokenPath) {
    const raw = readFileSync(config.operatorTokenPath, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  }
  const env = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
  return env && env.length > 0 ? env : undefined;
}
