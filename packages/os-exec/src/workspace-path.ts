import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  override readonly name = "PathEscapeError";
  constructor(message = "path escapes workspace") {
    super(message);
  }
}

export class AbsolutePathRejectedError extends Error {
  override readonly name = "AbsolutePathRejectedError";
  constructor(message = "absolute paths are not allowed for tool paths") {
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

function validateUserRelativePath(userPath: string): void {
  if (userPath.includes("\0")) {
    throw new PathEscapeError("NUL byte in path");
  }
  if (isAbsolute(userPath)) {
    throw new AbsolutePathRejectedError();
  }
}

function logicalPathUnderRoot(workspaceRoot: string, userPath: string): { rootReal: string; joined: string } {
  validateUserRelativePath(userPath);
  const rootReal = realpathSync(workspaceRoot);
  const joined = resolve(rootReal, userPath);
  assertInsideRoot(rootReal, joined);
  return { rootReal, joined };
}

function ensureWriteParentContained(rootReal: string, logicalFile: string): void {
  let dir = dirname(logicalFile);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    try {
      const realDir = realpathSync(dir);
      assertInsideRoot(rootReal, realDir);
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
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

/**
 * Resolve a session-relative path for read: logical path must stay under workspace;
 * final target is realpath'd so symlink escapes are rejected.
 */
export function resolvePathForRead(workspaceRoot: string, userPath: string): string {
  const { rootReal, joined } = logicalPathUnderRoot(workspaceRoot, userPath);
  const realTarget = realpathSync(joined);
  assertInsideRoot(rootReal, realTarget);
  return realTarget;
}

/**
 * Resolve a session-relative path for write: parent directories must exist and resolve under workspace.
 */
export function resolvePathForWrite(workspaceRoot: string, userPath: string): string {
  const { rootReal, joined } = logicalPathUnderRoot(workspaceRoot, userPath);
  ensureWriteParentContained(rootReal, joined);
  return joined;
}
