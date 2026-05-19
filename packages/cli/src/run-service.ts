/**
 * Service CLI commands for managed services.
 */

import { loadLayeredConfig, LAYOUT, VERSION } from "@shoggoth/shared";
import { invokeControlRequest } from "@shoggoth/daemon/lib";

interface ControlRequestParams {
  socketPath: string;
  auth: { kind: "operator_token"; token: string };
  op: string;
  payload: Record<string, unknown>;
}

// Re-export types for tests
export interface ServiceListItem {
  id: string;
  tier: string;
  status: string;
  tools: number;
  capabilities: string[];
  url?: string;
  healthy: boolean;
  label?: string;
}

export interface ServiceRequestItem {
  id: string;
  status: string;
  label?: string;
  tier?: string;
  capabilities: string[];
  updatedAt: string;
}

export interface ServiceDetailTool {
  name: string;
  description: string;
  method: string;
  path: string;
}

export interface ServiceDetail {
  id: string;
  label?: string;
  tier?: string;
  status: string;
  url?: string;
  healthy: boolean;
  capabilities: string[];
  ops: string[];
  tools: ServiceDetailTool[];
  registeredTools?: string[];
  createdAt?: string;
  updatedAt?: string;
  diff?: {
    oldFingerprint: string;
    newFingerprint: string;
    changes: string[];
  };
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

export function printServiceHelp(): void {
  console.log(`shoggoth ${VERSION}
Usage:
  shoggoth service list                    List all services
  shoggoth service requests                List pending approval requests
  shoggoth service request <id>            Show service details
  shoggoth service approve <id>            Approve a service
  shoggoth service revoke <id>             Revoke a service`);
}

export function parseServiceListArgs(argv: string[]): {
  ok: boolean;
  payload: Record<string, unknown>;
} {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, payload: {} };
  }
  // Reject any unexpected args
  if (argv.some((arg) => arg.startsWith("-"))) {
    return { ok: false, payload: {} };
  }
  return { ok: true, payload: {} };
}

export function parseServiceRequestsArgs(argv: string[]): {
  ok: boolean;
  payload: Record<string, unknown>;
} {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, payload: {} };
  }
  // Reject any unexpected args
  if (argv.some((arg) => arg.startsWith("-"))) {
    return { ok: false, payload: {} };
  }
  return { ok: true, payload: {} };
}

export function parseServiceRequestArgs(argv: string[]): {
  ok: boolean;
  payload: { service_id: string };
} {
  if (argv.length === 0) {
    return { ok: false, payload: { service_id: "" } };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, payload: { service_id: "" } };
  }
  return { ok: true, payload: { service_id: argv[0] } };
}

export function parseServiceApproveArgs(argv: string[]): {
  ok: boolean;
  payload: Record<string, unknown>;
} {
  if (argv.length === 0) {
    return { ok: false, payload: {} };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, payload: {} };
  }

  const serviceId = argv[0];
  const payload: Record<string, unknown> = { service_id: serviceId };

  // Parse --fingerprint option
  const fpIndex = argv.indexOf("--fingerprint");
  if (fpIndex !== -1 && argv[fpIndex + 1]) {
    payload.fingerprint = argv[fpIndex + 1];
  }

  return { ok: true, payload };
}

export function parseServiceRevokeArgs(argv: string[]): {
  ok: boolean;
  payload: Record<string, unknown>;
} {
  if (argv.length === 0) {
    return { ok: false, payload: {} };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { ok: true, payload: {} };
  }

  const serviceId = argv[0];
  const payload: Record<string, unknown> = { service_id: serviceId };

  // Parse --force option
  if (argv.includes("--force")) {
    payload.force = true;
  }

  return { ok: true, payload };
}

export function formatServiceListOutput(services: ServiceListItem[]): string {
  if (services.length === 0) {
    return "No services registered";
  }

  const lines: string[] = [];
  lines.push("ID             TIER       STATUS       TOOLS  CAPABILITIES");
  lines.push("─".repeat(70));

  for (const svc of services) {
    const id = svc.id.padEnd(14);
    const tier = (svc.tier || "unknown").padEnd(10);
    const status = svc.status.padEnd(11);
    const tools = String(svc.tools).padEnd(6);
    const caps =
      (svc.capabilities || []).slice(0, 3).join(", ") +
      ((svc.capabilities?.length ?? 0) > 3 ? "..." : "");
    lines.push(`${id} ${tier} ${status} ${tools} ${caps}`);
  }

  return lines.join("\n");
}

export function formatServiceRequestsOutput(requests: ServiceRequestItem[]): string {
  if (requests.length === 0) {
    return "No pending service requests";
  }

  const lines: string[] = [];
  lines.push("ID             STATUS              TIER       CAPABILITIES");
  lines.push("─".repeat(65));

  for (const req of requests) {
    const id = req.id.padEnd(14);
    const status = req.status.padEnd(18);
    const tier = (req.tier || "-").padEnd(10);
    const caps =
      (req.capabilities || []).slice(0, 3).join(", ") +
      ((req.capabilities?.length ?? 0) > 3 ? "..." : "");
    lines.push(`${id} ${status} ${tier} ${caps}`);
  }

  return lines.join("\n");
}

export function formatServiceRequestOutput(service: ServiceDetail): string {
  const lines: string[] = [];

  lines.push(`Service: ${service.id}`);
  if (service.label) lines.push(`Label: ${service.label}`);
  lines.push(`Tier: ${service.tier || "unknown"}`);
  lines.push(`Status: ${service.status}`);
  if (service.url) lines.push(`URL: ${service.url}`);
  lines.push(`Healthy: ${service.healthy ? "yes" : "no"}`);
  lines.push(`Capabilities: ${(service.capabilities || []).join(", ") || "(none)"}`);
  lines.push(`Ops: ${(service.ops || []).join(", ") || "(none)"}`);
  lines.push("");

  // Tools section
  if ((service.tools?.length ?? 0) > 0) {
    lines.push("Tools:");
    lines.push("  NAME        DESCRIPTION                     METHOD  PATH");
    lines.push("  " + "─".repeat(55));
    for (const tool of service.tools || []) {
      const name = tool.name.padEnd(10);
      const desc = (tool.description || "").slice(0, 28).padEnd(28);
      const method = tool.method.padEnd(6);
      lines.push(`  ${name} ${desc} ${method} ${tool.path}`);
    }
  } else {
    lines.push("Tools: (none)");
  }

  // Diff section for pending-reapproval
  if (service.diff) {
    lines.push("");
    lines.push("Changes:");
    lines.push(`  Old fingerprint: ${service.diff.oldFingerprint}`);
    lines.push(`  New fingerprint: ${service.diff.newFingerprint}`);
    for (const change of service.diff.changes) {
      lines.push(`  - ${change}`);
    }
  }

  return lines.join("\n");
}

export function formatServiceApproveOutput(
  serviceId: string,
  success: boolean,
  error?: string,
): string {
  if (success) {
    return `Service '${serviceId}' has been approved.`;
  }
  return `Failed to approve service '${serviceId}': ${error || "Unknown error"}`;
}

export function formatServiceRevokeOutput(
  serviceId: string,
  success: boolean,
  error?: string,
): string {
  if (success) {
    return `Service '${serviceId}' has been revoked.`;
  }
  return `Failed to revoke service '${serviceId}': ${error || "Unknown error"}`;
}

export async function runServiceListCli(
  params: Omit<ControlRequestParams, "op" | "payload">,
): Promise<void> {
  const res = await invokeControlRequest({
    ...params,
    op: "service.list",
    payload: {},
  });

  if (res.error) {
    console.error(res.error);
    process.exitCode = 1;
    return;
  }

  const services = (res as unknown as { services: ServiceListItem[] }).services || [];
  console.log(formatServiceListOutput(services));
}

export async function runServiceRequestsCli(
  params: Omit<ControlRequestParams, "op" | "payload">,
): Promise<void> {
  const res = await invokeControlRequest({
    ...params,
    op: "service.requests",
    payload: {},
  });

  if (res.error) {
    console.error(res.error);
    process.exitCode = 1;
    return;
  }

  const requests = (res as unknown as { requests: ServiceRequestItem[] }).requests || [];
  console.log(formatServiceRequestsOutput(requests));
}

export async function runServiceRequestCli(
  serviceId: string,
  params: Omit<ControlRequestParams, "op" | "payload">,
): Promise<void> {
  const res = await invokeControlRequest({
    ...params,
    op: "service.request",
    payload: { service_id: serviceId },
  });

  if (res.error) {
    console.error(res.error);
    process.exitCode = 1;
    return;
  }

  const result = res as unknown as { service: ServiceDetail };
  console.log(formatServiceRequestOutput(result.service));
}

export async function runServiceApproveCli(
  serviceId: string,
  params: Omit<ControlRequestParams, "op" | "payload">,
): Promise<void> {
  const res = await invokeControlRequest({
    ...params,
    op: "service.approve",
    payload: { service_id: serviceId },
  });

  const success = (res as { ok: boolean }).ok === true;
  const error = res.error ? String(res.error) : undefined;
  console.log(formatServiceApproveOutput(serviceId, success, error));
  if (!success) process.exitCode = 1;
}

export async function runServiceRevokeCli(
  serviceId: string,
  params: Omit<ControlRequestParams, "op" | "payload">,
): Promise<void> {
  const res = await invokeControlRequest({
    ...params,
    op: "service.revoke",
    payload: { service_id: serviceId },
  });

  const success = (res as { ok: boolean }).ok === true;
  const error = res.error ? String(res.error) : undefined;
  console.log(formatServiceRevokeOutput(serviceId, success, error));
  if (!success) process.exitCode = 1;
}

export async function runServiceCli(argv: string[]): Promise<void> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    printServiceHelp();
    return;
  }

  const configDir = process.env.SHOGGOTH_CONFIG_DIR ?? LAYOUT.configDir;
  const socketPath = socketPathFromEnv(configDir);
  const auth = controlAuth();

  const sub = argv[0];

  if (sub === "list") {
    const parsed = parseServiceListArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error("usage: shoggoth service list");
      process.exitCode = 1;
      return;
    }
    await runServiceListCli({ socketPath, auth });
    return;
  }

  if (sub === "requests") {
    const parsed = parseServiceRequestsArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error("usage: shoggoth service requests");
      process.exitCode = 1;
      return;
    }
    await runServiceRequestsCli({ socketPath, auth });
    return;
  }

  if (sub === "request") {
    const parsed = parseServiceRequestArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error("usage: shoggoth service request <id>");
      process.exitCode = 1;
      return;
    }
    await runServiceRequestCli(parsed.payload.service_id, { socketPath, auth });
    return;
  }

  if (sub === "approve") {
    const parsed = parseServiceApproveArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error("usage: shoggoth service approve <id> [--fingerprint <fp>]");
      process.exitCode = 1;
      return;
    }
    await runServiceApproveCli(parsed.payload.service_id as string, { socketPath, auth });
    return;
  }

  if (sub === "revoke") {
    const parsed = parseServiceRevokeArgs(argv.slice(1));
    if (!parsed.ok) {
      console.error("usage: shoggoth service revoke <id> [--force]");
      process.exitCode = 1;
      return;
    }
    await runServiceRevokeCli(parsed.payload.service_id as string, { socketPath, auth });
    return;
  }

  printServiceHelp();
  process.exitCode = 1;
}
