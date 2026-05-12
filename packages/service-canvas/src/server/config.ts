/**
 * Canvas Server Configuration
 */

export interface CanvasConfig {
  host: string;
  port: number;
  basePath: string;
  skipConfirm: boolean;
  a2uiDbPath: string;
  ignoreDirs: string[];
  agentWorkspaces: Record<string, string>;
}

export const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  host: "0.0.0.0",
  port: 3456,
  basePath: "/",
  skipConfirm: false,
  a2uiDbPath: "/var/lib/shoggoth/state/a2ui.db",
  ignoreDirs: ["tmp", "jsonl"],
  agentWorkspaces: {},
};
