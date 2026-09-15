import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Cache realpathSync results per workspace root to avoid repeated syscalls
const realpathCache = new Map<string, string>();
function cachedRealpathSync(workspaceRoot: string): string {
  let cached = realpathCache.get(workspaceRoot);
  if (cached === undefined) {
    cached = realpathSync(workspaceRoot);
    realpathCache.set(workspaceRoot, cached);
  }
  return cached;
}

export class PathEscapeError extends Error {
  override readonly name = "PathEscapeError";
  constructor(message = "path escapes workspace") {
    super(message);
  }
}

function assertInsideRoot(rootReal: string, absolutePath: string): void {
  const rel = relative(rootReal, absolutePath);
  if (rel === "..") {
    throw new PathEscapeError();
  }
  if (rel.startsWith(`..${sep}`)) {
    throw new PathEscapeError();
  }
}

function validatePath(userPath: string): void {
  if (userPath.includes("\0")) {
    throw new PathEscapeError("NUL byte in path");
  }
}

function logicalPathUnderRoot(
  workspaceRoot: string,
  userPath: string,
): { rootReal: string; joined: string } {
  validatePath(userPath);
  const rootReal = cachedRealpathSync(workspaceRoot);

  // Accept both absolute and relative paths
  const joined = isAbsolute(userPath) ? userPath : resolve(rootReal, userPath);
  assertInsideRoot(rootReal, joined);
  return { rootReal, joined };
}

function ensureWriteParentContained(rootReal: string, logicalFile: string): void {
  let dir = dirname(logicalFile);
  const visited = new Set<string>();
  while (true) {
    try {
      const realDir = realpathSync(dir);
      if (visited.has(realDir)) {
        throw new PathEscapeError("path escape: symlink cycle detected");
      }
      visited.add(realDir);
      assertInsideRoot(rootReal, realDir);
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // Directory doesn't exist yet — walk up to check the parent.
        const parent = dirname(dir);
        if (parent === dir) {
          throw new PathEscapeError("invalid path");
        }
        dir = parent;
        continue;
      }
      throw e;
    }
  }
}

/** Default set of absolute directory prefixes that are readable (but never writable). */
export const DEFAULT_ADDITIONAL_READ_ROOTS: readonly string[] = ["/app"];

/**
 * Resolve a session-relative or absolute path for read: logical path must stay under workspace
 * **or** under one of the additional read roots (default: `/app`).
 * Final target is realpath'd so symlink escapes are rejected.
 *
 * Accepts both:
 * - Relative paths (resolved relative to workspace root)
 * - Absolute paths (validated to be within workspace root or an additional read root)
 */
export function resolvePathForRead(
  workspaceRoot: string,
  userPath: string,
  additionalReadRoots: readonly string[] = DEFAULT_ADDITIONAL_READ_ROOTS,
): string {
  try {
    const { rootReal, joined } = logicalPathUnderRoot(workspaceRoot, userPath);
    const realTarget = realpathSync(joined);
    assertInsideRoot(rootReal, realTarget);
    return realTarget;
  } catch (e) {
    if (!(e instanceof PathEscapeError)) throw e;

    // If the workspace check failed, try each additional read root.
    validatePath(userPath);
    if (isAbsolute(userPath)) {
      for (const root of additionalReadRoots) {
        try {
          const rootReal = realpathSync(root);
          const resolved = resolve(userPath);
          // Logical path must be inside the root
          assertInsideRoot(rootReal, resolved);
          // Real path (after symlink resolution) must also be inside the root
          const realTarget = realpathSync(resolved);
          assertInsideRoot(rootReal, realTarget);
          return realTarget;
        } catch {
          // Root doesn't exist or path escapes this root — try next root.
          continue;
        }
      }
    }

    throw e;
  }
}

/**
 * Resolve a session-relative or absolute path for write: parent directories must exist and resolve under workspace.
 *
 * Accepts both:
 * - Relative paths (resolved relative to workspace root)
 * - Absolute paths (validated to be within workspace root)
 */
export function resolvePathForWrite(workspaceRoot: string, userPath: string): string {
  const { rootReal, joined } = logicalPathUnderRoot(workspaceRoot, userPath);
  ensureWriteParentContained(rootReal, joined);
  return joined;
}
