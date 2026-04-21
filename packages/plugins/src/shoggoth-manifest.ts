import { z } from "zod";

const pluginKindSchema = z.enum([
  "messaging-platform",
  "observability",
  "general",
]);

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
    name: z.string().min(1).parse(packageJson.name),
    version: z.string().min(1).parse(packageJson.version),
    kind: bag.kind,
    entrypoint: bag.entrypoint,
  };
}
