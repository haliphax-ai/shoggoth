/**
 * Check whether spawning a new subagent is allowed at the given depth.
 * Returns true if spawning is allowed, false otherwise.
 */
export function canSpawn(currentDepth: number, maxDepth: number): boolean {
  return currentDepth < maxDepth;
}
