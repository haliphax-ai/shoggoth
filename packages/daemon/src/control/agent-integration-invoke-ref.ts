import type { AgentIntegrationInvoker } from "./integration-invoke";

let current: AgentIntegrationInvoker | undefined;

export function setAgentIntegrationInvoker(fn: AgentIntegrationInvoker | undefined): void {
  current = fn;
}

export function getAgentIntegrationInvoker(): AgentIntegrationInvoker | undefined {
  return current;
}
