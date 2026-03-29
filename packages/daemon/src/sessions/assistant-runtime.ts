import {
  createFailoverToolCallingClientFromModelsConfig,
  type CreateFailoverFromConfigOptions,
  type FailoverToolCallingClient,
} from "@shoggoth/models";
import type { ShoggothConfig } from "@shoggoth/shared";
import { connectShoggothMcpServers } from "../mcp/mcp-server-pool";
import { runToolLoop, type RunToolLoopOptions } from "./tool-loop";

export interface DiscordPlatformAssistantDeps {
  readonly createToolCallingClient: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;
  readonly runToolLoopImpl: (opts: RunToolLoopOptions) => Promise<void>;
  readonly connectShoggothMcpServers: typeof connectShoggothMcpServers;
}

export const defaultDiscordAssistantDeps: DiscordPlatformAssistantDeps = {
  createToolCallingClient: createFailoverToolCallingClientFromModelsConfig,
  runToolLoopImpl: runToolLoop,
  connectShoggothMcpServers,
};
