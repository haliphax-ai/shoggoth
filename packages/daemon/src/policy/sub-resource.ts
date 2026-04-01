/**
 * Sub-resource extraction for HITL compound resource matching.
 *
 * A sub-resource extractor takes tool call args and returns a sub-resource
 * identifier (e.g. the command name for `exec`). The policy engine then
 * evaluates against `toolName:subResource` instead of just `toolName`.
 */

/** Extractor signature: returns a sub-resource string, or undefined to fall back to bare tool name. */
export type SubResourceExtractor = (args: Record<string, unknown>) => string | undefined;

/** Registry mapping tool names to their sub-resource extractors. */
export type SubResourceExtractorRegistry = Map<string, SubResourceExtractor>;

/**
 * Extract the command name (basename of first token) from exec tool args.
 *
 * Examples:
 *   "curl https://example.com"       → "curl"
 *   "/usr/bin/curl https://example.com" → "curl"
 *   "bash -c 'echo hello'"           → "bash"
 *   ""                                → "unknown"
 */
export function execSubResourceExtractor(args: Record<string, unknown>): string {
  const cmd = String(args.command ?? "").trim();
  const firstToken = cmd.split(/\s+/)[0] ?? "";
  const slash = firstToken.lastIndexOf("/");
  return (slash >= 0 ? firstToken.slice(slash + 1) : firstToken) || "unknown";
}

/**
 * Resolve the compound resource string for a tool call.
 *
 * If the tool has a registered extractor and it returns a value,
 * the result is `toolName:subResource`. Otherwise, returns the bare tool name.
 */
export function resolveCompoundResource(
  toolName: string,
  args: Record<string, unknown>,
  registry: SubResourceExtractorRegistry,
): string {
  const extractor = registry.get(toolName);
  if (!extractor) return toolName;
  const sub = extractor(args);
  if (sub === undefined) return toolName;
  return `${toolName}:${sub}`;
}

/**
 * Create a default registry with the exec sub-resource extractor pre-registered.
 */
export function createDefaultSubResourceRegistry(): SubResourceExtractorRegistry {
  const registry: SubResourceExtractorRegistry = new Map();
  registry.set("builtin.exec", execSubResourceExtractor);
  return registry;
}
