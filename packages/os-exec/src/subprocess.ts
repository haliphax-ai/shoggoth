import { spawn } from "node:child_process";

export interface RunAsUserResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunAsUserOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  uid: number;
  gid: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stream) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * Spawn a subprocess with POSIX `uid` / `gid` (Node passes these to `posix_spawn` on Linux).
 * The parent should remain privileged; the child runs as the agent identity for kernel DAC.
 */
export function runAsUser(options: RunAsUserOptions): Promise<RunAsUserResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      uid: options.uid,
      gid: options.gid,
      stdio: options.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    child.on("error", reject);

    if (child.stdin && options.stdin !== undefined) {
      child.stdin.write(options.stdin, "utf8");
      child.stdin.end();
    }

    const outP = collectStream(child.stdout);
    const errP = collectStream(child.stderr);

    child.on("close", (exitCode, signal) => {
      void Promise.all([outP, errP])
        .then(([stdout, stderr]) => {
          resolve({ stdout, stderr, exitCode, signal });
        })
        .catch(reject);
    });
  });
}
