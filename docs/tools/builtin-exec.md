# builtin-exec

Run shell commands and poll background processes.

## exec

Execute a command via the system shell. Returns combined or split stdout/stderr.

### Parameters

| Param          | Type     | Required | Notes                                                                                                                          |
| -------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `argv`         | string[] | yes      | Command + arguments                                                                                                            |
| `timeout`      | number   | no       | Max milliseconds before SIGTERM → SIGKILL (default: 30000)                                                                     |
| `stdin`        | string   | no       | Written to stdin, then closed                                                                                                  |
| `workdir`      | string   | no       | Working directory (absolute or workspace-relative)                                                                             |
| `env`          | object   | no       | Key-value pairs merged into process env                                                                                        |
| `splitStreams` | boolean  | no       | Return `stdout`/`stderr` separately (default: false → combined `output`)                                                       |
| `maxOutput`    | number   | no       | Max characters per stream. System cap: ~1 MB, default: ~200 KB                                                                 |
| `truncation`   | string   | no       | `"head"`, `"tail"` (default), or `"both"` — which end to keep                                                                  |
| `background`   | boolean  | no       | Start in the background immediately and return a session handle                                                                |
| `yieldMs`      | number   | no       | Wait up to this many ms for completion; still running → background. Capped at 30 s (configurable via `runtime.execMaxYieldMs`) |
| `notify`       | boolean  | no       | With `background`/`yieldMs`: notify the session when the process completes (default: true)                                     |
| `stdoutFile`   | string   | no       | Write stdout to this workspace-relative file instead of returning inline                                                       |
| `stderrFile`   | string   | no       | Write stderr to this workspace-relative file instead of returning inline                                                       |
| `outputFile`   | string   | no       | Write combined output to this file (mutually exclusive with stdoutFile/stderrFile)                                             |

### Newline Preservation in argv Strings

When passing multiline scripts in `argv` strings (especially with `bash -c` or `sh -c`), newlines are preserved through proper JSON escaping:

- In JSON, `\n` represents an actual newline character
- When passed to the shell, these newlines are preserved in the command string
- Proper quoting ensures literal characters are maintained

**Example: multiline script with bash**

```json
{
  "argv": ["bash", "-c", "echo 'line 1'\necho 'line 2'\necho 'line 3'"]
}
```

This executes as:

```bash
bash -c "echo 'line 1'
echo 'line 2'
echo 'line 3'"
```

**Example: complex multiline script**

```json
{
  "argv": ["bash", "-c", "for i in 1 2 3; do\n  echo \"Number: $i\"\ndone"]
}
```

### Shell Escaping Expectations

The tool expects arguments to be properly formatted for shell execution:

1. **Command and arguments as separate array elements**
   - `argv[0]` is the command to execute
   - `argv[1..]` are the arguments passed to the command

2. **For bash -c or sh -c, the script should be a single argument**
   - Wrong: `["bash", "-c", "echo", "hello"]` (echo and hello are separate args)
   - Right: `["bash", "-c", "echo hello"]` (entire script is one argument)

3. **JSON string escaping**
   - `\n` in JSON becomes actual newline in the string
   - `\\n` in JSON becomes literal `\n` in the string
   - Use proper escaping for quotes and special characters

### Return Value Structure

**Default (combined output):**

```json
{
  "stdout": "command output here",
  "stderr": "",
  "exitCode": 0
}
```

**Split streams:**

```json
{
  "stdout": "standard output",
  "stderr": "error output",
  "exitCode": 0
}
```

**Error case:**

```json
{
  "error": "Failed to execute command: ...",
  "stdout": "",
  "stderr": "",
  "exitCode": -1
}
```

### Examples

**Simple command:**

```json
{ "argv": ["ls", "-la"] }
```

**Command with timeout:**

```json
{
  "argv": ["sleep", "10"],
  "timeout": 5000
}
```

**Command with stdin:**

```json
{
  "argv": ["grep", "error"],
  "stdin": "line1\nerror here\nline3\n",
  "timeout": 5000
}
```

**Multiline bash script:**

```json
{
  "argv": [
    "bash",
    "-c",
    "echo 'Starting process...'\nfor i in 1 2 3; do\n  echo \"Processing item $i\"\ndone\necho 'Done!'"
  ]
}
```

**Split streams with truncation:**

```json
{
  "argv": ["sh", "-c", "echo ok; echo fail >&2"],
  "splitStreams": true,
  "truncation": "tail"
}
```

**Command with custom working directory:**

```json
{
  "argv": ["git", "status"],
  "workdir": "src"
}
```

**Command with custom environment:**

```json
{
  "argv": ["echo", "$MY_VAR"],
  "env": { "MY_VAR": "hello world" }
}
```

**Complex multiline script with quotes:**

```json
{
  "argv": ["bash", "-c", "echo \"nested 'quotes' in \\\"multiline\\\" lines\""]
}
```

## Output Truncation

When output exceeds `maxOutput` (default 200KB):

- `truncation: "head"` - keeps beginning, truncates end
- `truncation: "tail"` - keeps end, truncates beginning (default)
- `truncation: "both"` - keeps beginning and end, truncates middle

Truncated output includes a marker: `[... truncated X chars ...]`

## File Output

Instead of returning output inline, you can write it to workspace files for later processing with `builtin-read`.

**Rules:**

- `outputFile` writes combined stdout+stderr to a single file. Mutually exclusive with `stdoutFile`/`stderrFile`.
- `stdoutFile` and `stderrFile` can be used together or separately. Non-redirected streams are returned inline.
- With `background`/`yieldMs`, output streams directly to the file(s) as it is produced (no size cap).
- Files are created even if output is empty (zero-byte file).
- Files are written even on non-zero exit codes.
- Paths are validated to stay within the workspace boundary.

**Examples:**

Combined output to file:

```json
{
  "argv": ["find", ".", "-name", "*.ts"],
  "outputFile": "tmp/ts-files.txt"
}
```

Separate stdout and stderr:

```json
{
  "argv": ["npm", "run", "build"],
  "stdoutFile": "tmp/build.log",
  "stderrFile": "tmp/build-errors.log"
}
```

Only capture stderr (stdout returned inline):

```json
{
  "argv": ["node", "script.js"],
  "stderrFile": "tmp/errors.log"
}
```

Reading the output file afterward:

```json
{ "tool": "builtin-read", "args": { "path": "tmp/ts-files.txt" } }
```

## Background Execution & Completion Notifications

Long-running commands don't have to block a turn:

- `background: true` starts the process immediately and returns
  `{ "status": "running", "sessionId": "exec-…", "pid": N }`.
- `yieldMs: <ms>` waits up to that many milliseconds for the command to
  finish; if it is still running, the same background handle is returned
  (with `yielded: true` and any partial output). Values above the cap are
  clamped to it, never ignored. The cap defaults to 30000 ms and is
  configurable via `runtime.execMaxYieldMs` (or `SHOGGOTH_EXEC_MAX_YIELD_MS`).
- `notify` (default `true`) registers the backgrounded call for a completion
  notification: when the process exits, the session receives an
  out-of-band turn carrying the exit code and the output — respecting the
  call's output options (`splitStreams`, `maxOutput`/`truncation`, and
  `stdoutFile`/`stderrFile`/`outputFile`) exactly as a blocking call would
  have. Pass `notify: false` to opt out and rely on `builtin-poll` instead.
- In-flight notify handles appear in the turn status bar after the timers
  section (↩️ `N`); the toggle is `platforms.statusBar.notifyEnabled`
  (default true).

## Tips

- Use `splitStreams: true` when you need to separate stdout and stderr
- Set `timeout` to prevent long-running commands from hanging
- For multiline scripts, use bash -c with properly escaped newlines
- Use `env` to pass environment variables without modifying the parent process
- The `workdir` parameter supports both absolute paths and workspace-relative paths
- Exit code 0 typically indicates success, non-zero indicates failure
- When a command times out, it receives SIGTERM, then SIGKILL after 5 seconds
