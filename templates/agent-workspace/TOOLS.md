# TOOLS.md

## General rules/guidelines

- File tools use paths relative to your workspace directory. They will not permit you to reach outside of the workspace. This is **for security purposes**.
- Use the `choices` option of the `builtin-message` tool to provide the user with selections.
- Use the `builtin-workflow` tool for breaking large tasks into smaller ones, running tasks in parallel, and chaining dependent tasks.
- Use the `builtin-timer` tool instead of blocking poll/wait operations, but do **NOT** use a recurring timer for less than 30 minutes or you risk piling up the turn queue. Instead, add instructions to a one-shot reminder to set a follow-up reminder if conditions are met/unmet.
- **Read** a file before you start writing to it.
- **Carefully** inspect tool descriptors for syntax and required arguments **before** using tools.
- If a tool throws an exception, summarize the failure and suggest a fix or ask for guidance.
- Write scratch/temporary files to your workspace `tmp` folder and regularly clean it.

## builtin-exec

NOTE: `builtin-exec` is a _last resort_! Instead of using it to run shell commands (considered risky by policy) use LSP tools or these other tools instead:

| Tool            | Commands it replaces                                             |
| --------------- | ---------------------------------------------------------------- |
| builtin-cd      | cd                                                               |
| builtin-fs      | mv, cp, rm, stat, chmod                                          |
| builtin-ls      | ls, find                                                         |
| builtin-read    | cat                                                              |
| builtin-replace | sed                                                              |
| builtin-search  | grep                                                             |
| builtin-timer   | sleep                                                            |
| builtin-write   | any command chain that writes to a file, e.g. `echo "x" > y.txt` |

For documentation and specific tool examples, see `/app/docs/tools/<tool name>.md`.

Chaining shell commands with `bash`, `sh`, etc. is considered **extremely** HIGH risk, and will likely be denied by the operator.

## Regular expressions

If you're having trouble properly escaping regular expression patterns, **stop using them** instead of repeatedly failing! There are modes for the `builtin-*` tools that read and write files that will let you act on lines and ranges with fixed strings instead of regex patterns.

Consider using `fixedStrings` or `replaceRange` when editing text instead of using regular expressions at all. The results are far more consistent and less error prone. Remember to read critical sections of files after replacing contents, as line numbers may have shifted.

## File Editing Rules

If you need to use `builtin-replace` to modify files, be smart about it. Batch your edits into a single tool call where possible. Otherwise, do the edits in reverse order (highest line numbers first) to avoid content shifting on you between tool calls.

Full file rewrites (`builtin-write`) are a last resort — they trade stale-line-number bugs for accidental content mutations. Prefer surgical `replaceRange` with fresh line numbers over rewriting files from scratch.

## More tools

More tools may be available to you beneath the `builtin-discover` meta tool. Before declaring that a tool doesn't exist and giving up, check there first!
