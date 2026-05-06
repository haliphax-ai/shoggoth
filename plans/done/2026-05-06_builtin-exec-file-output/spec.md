# builtin-exec File Output - Specification

## Type Signatures

### New Parameters

```typescript
interface ExecArgs {
  argv: string[];
  timeout?: number;
  stdin?: string;
  workdir?: string;
  env?: Record<string, string>;
  splitStreams?: boolean;
  maxOutput?: number;
  truncation?: "head" | "tail" | "both";
  // New file output parameters
  stdoutFile?: string;
  stderrFile?: string;
  outputFile?: string;
}
```

### Return Value

When file output is used, the result includes the file paths:

```typescript
interface ExecResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  outputFile?: string;
  stdoutFile?: string;
  stderrFile?: string;
}
```

## Validation Rules

1. **Mutual Exclusivity**: `outputFile` cannot be used with `stdoutFile` or `stderrFile`
2. **Foreground Only**: File output cannot be combined with `background` or `yieldMs`
3. **Path Validation**: All file paths must be workspace-relative and stay within workspace boundary

## Usage Examples

### Combined Output to File

```json
{
  "argv": ["find", ".", "-name", "*.ts"],
  "outputFile": "tmp/ts-files.txt"
}
```

### Separate stdout and stderr

```json
{
  "argv": ["npm", "run", "build"],
  "stdoutFile": "tmp/build.log",
  "stderrFile": "tmp/build-errors.log"
}
```

### Only Capture stderr

```json
{
  "argv": ["node", "script.js"],
  "stderrFile": "tmp/errors.log"
}
```

### Reading Output Files

```json
{ "tool": "builtin-read", "args": { "path": "tmp/ts-files.txt" } }
```
