import { z } from "zod";

const pluginKindSchema = z.enum(["messaging-platform", "observability", "general", "service"]);

const pluginNameSchema = z.string().min(1);
const pluginVersionSchema = z.string().min(1);

/** Validates the `shoggothPlugin` property bag from package.json. */
export const shoggothPluginBagSchema = z
  .object({
    kind: pluginKindSchema.optional().default("general"),
    entrypoint: z.string().min(1),
  })
  .strict();

export type ShoggothPluginBag = z.infer<typeof shoggothPluginBagSchema>;

/** Resolved plugin metadata (combined from package.json top-level + shoggothPlugin). */
export interface ShoggothPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly kind: string;
  readonly entrypoint: string;
}

export function parseShoggothPluginBag(data: unknown): ShoggothPluginBag {
  return shoggothPluginBagSchema.parse(data);
}

/**
 * Read a plugin's package.json and extract metadata.
 * Throws if `shoggothPlugin` is missing or invalid.
 */
export function resolvePluginMeta(packageJson: Record<string, unknown>): ShoggothPluginMeta {
  const bag = parseShoggothPluginBag(packageJson.shoggothPlugin);
  return {
    name: pluginNameSchema.parse(packageJson.name),
    version: pluginVersionSchema.parse(packageJson.version),
    kind: bag.kind,
    entrypoint: bag.entrypoint,
  };
}
