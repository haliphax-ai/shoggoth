# builtin-search-replace

**Note:** This documentation refers to the legacy combined tool. For new implementations, see:

- [`builtin-search.md`](builtin-search.md) - Search functionality
- [`builtin-replace.md`](builtin-replace.md) - Replace functionality

This tool provides both search and replace actions for text manipulation in files.

## Actions

| Action    | Description                             |
| --------- | --------------------------------------- |
| `search`  | Search for patterns in files            |
| `replace` | Replace patterns in files with new text |

## Common Parameters

| Param    | Type   | Required | Notes                     |
| -------- | ------ | -------- | ------------------------- |
| `action` | string | yes      | `"search"` or `"replace"` |

## See Also

- [`builtin-search.md`](builtin-search.md) - Complete search documentation
- [`builtin-replace.md`](builtin-replace.md) - Complete replace documentation
