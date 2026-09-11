import { z } from "zod";
import { serviceDeclarationSchema } from "./services";

export const processDeclarationHealthSchema = z.object({ kind: z.enum(["tcp", "http", "stdout-match"]), target: z.string().min(1), timeoutMs: z.number().int().positive().optional() }).strict();
export type ProcessDeclarationHealth = z.infer<typeof processDeclarationHealthSchema>;
export const processDeclarationSchema = z.object({
  id: z.string().min(1), label: z.string().min(1).optional(), startPolicy: z.enum(["boot", "on-demand"]),
  command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(), restartMode: z.enum(["never", "on-failure", "always"]).optional(),
  maxRetries: z.number().int().nonnegative().optional(), health: processDeclarationHealthSchema.optional(),
  service: serviceDeclarationSchema.optional(),
}).strict();
export type ProcessDeclaration = z.infer<typeof processDeclarationSchema>;
