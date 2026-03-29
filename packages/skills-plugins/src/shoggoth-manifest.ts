import { z } from "zod";

const hookNameSchema = z.enum(["daemon.startup", "daemon.shutdown"]);

export const shoggothPluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    hooks: z.record(hookNameSchema, z.string().min(1)).optional(),
  })
  .strict();

export type ShoggothPluginManifest = z.infer<typeof shoggothPluginManifestSchema>;

export function parseShoggothPluginManifest(data: unknown): ShoggothPluginManifest {
  return shoggothPluginManifestSchema.parse(data);
}
