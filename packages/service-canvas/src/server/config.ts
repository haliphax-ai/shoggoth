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
  a2uiDbPath: "~/.shoggoth/canvas/a2ui-cache.db",
  ignoreDirs: ["tmp", "jsonl"],
  agentWorkspaces: {},
};
