import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Maximum number of entries retained in the workspace-root realpath cache. */
const REALPATH_CACHE_LIMIT = 256;

/**
 * Simple bounded LRU cache for workspace-root real paths.
 *
 * Entries are revalidated on every hit (see `cachedRealpathSync`), so eviction
 * is purely a memory bound: dropping the least recently used root merely costs
 * one `realpathSync` call on its next use.
 */
class RealpathLruCache {
  private readonly entries = new Map<string, string>();

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Re-inserting moves the entry to the back, marking it most recently used.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    if (this.entries.size > REALPATH_CACHE_LIMIT) {
      // `Map` iteration is insertion order, so the first key is the LRU entry.
      const lruKey = this.entries.keys().next();
      if (!lruKey.done) {
        this.entries.delete(lruKey.value);
      }
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

const realpathCache = new RealpathLruCache();

/**
 * Resolve the real path of a workspace root, caching results per input path.
 *
 * A cached value is reused only while it matches the current (device, inode)
 * of `workspaceRoot`; otherwise it is refreshed via `realpathSync`. The cache
 * is LRU-bounded so it cannot grow without limit during a daemon lifetime.
 */
export function cachedRealpathSync(workspaceRoot: string): string {
  let cached = realpathCache.get(workspaceRoot);
  if (cached !== undefined) {
    try {
      // `lstatSync` (not `statSync`) so a cached path that has itself become a
      // symlink is treated as stale instead of matching through its target.
      const cachedStat = lstatSync(cached, { bigint: true });
      const rootStat = statSync(workspaceRoot, { bigint: true });
      if (
        cachedStat.isDirectory() &&
        cachedStat.dev === rootStat.dev &&
        cachedStat.ino === rootStat.ino
      ) {
        return cached;
      }
    } catch {
      // lstat/stat failure (ENOENT, EACCES, ...): fall through to re-resolve.
    }
    realpathCache.delete(workspaceRoot);
  }
  cached = realpathSync(workspaceRoot);
  realpathCache.set(workspaceRoot, cached);
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
