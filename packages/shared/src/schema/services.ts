import { z } from "zod";
import type { ProcessDeclaration } from "./processes";

export const serviceDeclarationSchema = z.object({ port: z.number().int().min(1).max(65535), protocol: z.enum(["http", "ws", "http+ws"]), basePath: z.string().optional().default("/"), capabilities: z.array(z.string().min(1)).optional(), expose: z.enum(["gateway", "direct", "both"]).optional().default("direct"), manifestPath: z.string().optional().default("/manifest"), host: z.string().optional().default("127.0.0.1") }).strict();
export type ServiceDeclaration = z.infer<typeof serviceDeclarationSchema>;
export const serviceToolDeclarationSchema = z.object({ name: z.string().min(1), description: z.string().min(1), parameters: z.record(z.unknown()), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().min(1), dispatch: z.enum(["body", "query", "path"]).optional().default("body") }).strict();
export type ServiceToolDeclaration = z.infer<typeof serviceToolDeclarationSchema>;
export const manifestWsEndpointSchema = z.object({ path: z.string().min(1), description: z.string().optional(), protocol: z.string().optional() }).strict();
export const serviceManifestSchema = z.object({ name: z.string().min(1), version: z.string().min(1), tools: z.array(serviceToolDeclarationSchema).optional(), ops: z.array(z.string().min(1)).optional(), wsEndpoints: z.array(manifestWsEndpointSchema).optional() }).strict();
export type ServiceManifest = z.infer<typeof serviceManifestSchema>;
export const approvalStatusValues = ["pending", "approved", "pending-reapproval", "revoked"] as const;
export type ApprovalStatus = (typeof approvalStatusValues)[number];
export interface ServiceApprovalRecord { serviceId: string; status: ApprovalStatus; approvedFingerprint: string | null; keyFingerprint: string | null; createdAt: string; updatedAt: string; }
export function validateServicePortConflicts(processes: ProcessDeclaration[]): void {
  const portMap = new Map<string, string>();
  for (const proc of processes) { if (!proc.service) continue; const host = proc.service.host ?? "127.0.0.1"; const key = `${host}:${proc.service.port}`; const existing = portMap.get(key); if (existing) throw new Error(`Service port conflict: processes "${existing}" and "${proc.id}" both declare ${key}`); portMap.set(key, proc.id); }
}
export const externalServiceHealthSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("tcp"), port: z.number().int().min(1).max(65535).optional(), timeoutMs: z.number().int().positive().optional().default(5000) }).strict(), z.object({ kind: z.literal("http"), url: z.string().url(), expectedStatus: z.number().int().optional().default(200), timeoutMs: z.number().int().positive().optional().default(5000) }).strict()]);
export type ExternalServiceHealth = z.infer<typeof externalServiceHealthSchema>;
export const externalServiceDeclarationSchema = z.object({ id: z.string().min(1), label: z.string().min(1).optional(), host: z.string().min(1), port: z.number().int().min(1).max(65535), protocol: z.enum(["http", "ws", "http+ws"]), basePath: z.string().optional().default("/"), capabilities: z.array(z.string().min(1)).optional(), expose: z.enum(["gateway", "direct", "both"]).optional().default("direct"), manifestPath: z.string().optional().default("/manifest"), health: externalServiceHealthSchema, healthIntervalMs: z.number().int().positive().optional().default(30000), unhealthyThreshold: z.number().int().positive().optional().default(3) }).strict();
export type ExternalServiceDeclaration = z.infer<typeof externalServiceDeclarationSchema>;
export function validateServiceIdConflicts(config: { services?: ExternalServiceDeclaration[]; processes?: ProcessDeclaration[] }): string[] {
  const errors: string[] = []; const ids = new Set<string>();
  for (const proc of config.processes ?? []) { if (!proc.service) continue; if (ids.has(proc.id)) errors.push(`Duplicate service ID: "${proc.id}"`); ids.add(proc.id); }
  for (const svc of config.services ?? []) { if (ids.has(svc.id)) errors.push(`Duplicate service ID: "${svc.id}"`); ids.add(svc.id); }
  return errors;
}
export const gatewayConfigSchema = z.object({ enabled: z.boolean().default(false), port: z.number().int().min(1).max(65535).default(8000), host: z.string().default("0.0.0.0"), prefix: z.string().default("/svc"), cors: z.object({ origins: z.array(z.string()), credentials: z.boolean().optional() }).optional(), rateLimit: z.object({ windowMs: z.number().int().positive(), maxRequests: z.number().int().positive() }).optional() }).strict().optional();
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
