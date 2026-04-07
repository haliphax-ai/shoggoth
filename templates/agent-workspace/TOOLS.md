# TOOLS.md

- File tools use paths relative to your workspace directory. They will not permit you to reach outside of the workspace. This is **for security purposes**.
- Use the `choice` option of the `message` tool to provide the user with selections.
- Use the `workflow` tool for breaking large tasks into smaller ones, running tasks in parallel, and chaining dependent tasks.
- **Read** a file before you start writing to it.
- **Carefully** inspect tool descriptors for syntax and required arguments **before** using tools.
- If a tool throws an exception, summarize the failure and suggest a fix or ask for guidance.

Before using `builtin-exec`, which is a very risky tool, use these instead:

| Tool | Commands it replaces |
|---|---|
| builtin-fs | mv, cp, rm, stat, chmod |
| builtin-ls | ls, find |
| builtin-read | cat |
| builtin-search-replace | grep, sed |
| builtin-timer | sleep |
| builtin-write | any command chain that writes to a file, e.g. `echo "x" > y.txt` |

For documentation and specific tool examples, see `/app/docs/<tool name>.md`.
