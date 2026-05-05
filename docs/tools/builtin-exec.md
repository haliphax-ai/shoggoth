# builtin-exec

Run shell commands and poll background processes.

## exec

Execute a command via the system shell. Returns combined or split stdout/stderr.

### Parameters

| Param          | Type     | Required | Notes                                                                    |
| -------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `argv`         | string[] | yes      | Command + arguments                                                      |
| `timeout`      | number   | no       | Max milliseconds before SIGTERM → SIGKILL (default: 30000)               |
| `stdin`        | string   | no       | Written to stdin, then closed                                            |
| `workdir`      | string   | no       | Working directory (absolute or workspace-relative)                       |
| `env`          | object   | no       | Key-value pairs merged into process env                                  |
| `splitStreams` | boolean  | no       | Return `stdout`/`stderr` separately (default: false → combined `output`) |
| `maxOutput`    | number   | no       | Max characters per stream. System cap: ~1 MB, default: ~200 KB           |
| `truncation`   | string   | no       | `"head"`, `"tail"` (default), or `"both"` — which end to keep            |

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

## Tips

- Use `splitStreams: true` when you need to separate stdout and stderr
- Set `timeout` to prevent long-running commands from hanging
- For multiline scripts, use bash -c with properly escaped newlines
- Use `env` to pass environment variables without modifying the parent process
- The `workdir` parameter supports both absolute paths and workspace-relative paths
- Exit code 0 typically indicates success, non-zero indicates failure
- When a command times out, it receives SIGTERM, then SIGKILL after 5 seconds
