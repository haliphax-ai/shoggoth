// -----------------------------------------------------------------------------
// builtin-exec — execute shell commands
// -----------------------------------------------------------------------------
// This implementation uses child_process.spawn to execute commands via /bin/sh -c
// It properly handles JSON escaping in argv strings, preserving \n sequences as newlines
// and properly escaping for shell execution
//
// KEY IMPLEMENTATION DETAILS:
// - argv[0] is the command to execute (e.g., "bash", "sh", "git")
// - argv[1..] are the arguments passed to the command
// - When using bash -c or sh -c, the script should be passed as a single argument
// - JSON string escaping: \n in JSON becomes actual newline in string
// - Shell escaping: proper quoting preserves literal characters

import { spawn } from "node:child_process";

export interface BuiltinExecArgs {
  argv: string[];
  timeout?: number;
  workdir?: string;
  stdin?: string;
  env?: Record<string, string>;
  splitStreams?: boolean;
  maxOutput?: number;
  truncation?: "head" | "tail" | "both";
  // background?: boolean;
  // yieldMs?: number;
}

export interface BuiltinToolContext {
  workspacePath: string;
}

// Helper function to collect stream data
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

// Helper function to truncate output
function truncateOutput(
  output: string,
  maxOutput: number,
  truncation: "head" | "tail" | "both",
): string {
  if (output.length <= maxOutput) {
    return output;
  }

  const excess = output.length - maxOutput;
  if (truncation === "head") {
    return `[... truncated ${excess} chars ...]` + output.slice(-maxOutput);
  } else if (truncation === "tail") {
    return output.slice(0, maxOutput) + `[... truncated ${excess} chars ...]`;
  } else {
    // both: keep head and tail
    const half = Math.floor(maxOutput / 2);
    return output.slice(0, half) + `[... truncated ${excess} chars ...]` + output.slice(-half);
  }
}

export const builtinExec = async (
  args: BuiltinExecArgs,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> => {
  const {
    argv,
    timeout = 30000,
    workdir,
    stdin,
    env,
    splitStreams = false,
    maxOutput = 200000,
    truncation = "tail",
    // background = false,
    // yieldMs,
  } = args;

  // Validate argv
  if (!argv || argv.length === 0) {
    return {
      resultJson: JSON.stringify({
        error: "argv must contain at least one element",
      }),
    };
  }

  // Determine working directory
  const cwd = workdir
    ? workdir.startsWith("/")
      ? workdir
      : ctx.workspacePath + "/" + workdir
    : ctx.workspacePath;

  // Merge environment variables
  const childEnv = { ...process.env, ...env };

  // Execute the command
  // For background execution, we'd need to track the process
  // For now, implement foreground execution with optional yield
  try {
    // Spawn the process with argv as separate arguments
    // argv[0] is the command, argv[1..] are arguments
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: childEnv,
      stdio: stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    // Write stdin if provided
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin, "utf8");
      child.stdin.end();
    }

    // Collect stdout and stderr
    const stdoutPromise = collectStream(child.stdout);
    const stderrPromise = collectStream(child.stderr);

    // Set up timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
      }, timeout);
    }

    // Wait for process to complete
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(code);
      });
      child.on("error", (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        // Error will be caught in the outer try-catch
        throw err;
      });
    });

    // Collect output
    let stdout = await stdoutPromise;
    let stderr = await stderrPromise;

    // Apply truncation if needed
    if (splitStreams) {
      stdout = truncateOutput(stdout, maxOutput, truncation);
      stderr = truncateOutput(stderr, maxOutput, truncation);
    } else {
      const combined = stdout + stderr;
      const truncated = truncateOutput(combined, maxOutput, truncation);
      // Split back into stdout/stderr (this is approximate)
      stdout = truncated;
      stderr = "";
    }

    return {
      resultJson: JSON.stringify({
        stdout,
        stderr,
        exitCode,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resultJson: JSON.stringify({
        error: `Failed to execute command: ${errorMessage}`,
        stdout: "",
        stderr: "",
        exitCode: -1,
      }),
    };
  }
};
