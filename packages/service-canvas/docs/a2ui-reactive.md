# A2UI Reactive Data Binding Guide

The A2UI reactive layer lets agents push structured data sources to the canvas and bind UI components to that data. Filters, aggregates, and repeating templates update automatically as data or selections change.

## `formatString` interpolation

Interpolated strings in JSONL (e.g. `Text.text`, `ProgressBar` `label`/`value`, `Badge` `map`, `Repeat` templates) use **`${expression}`** syntax — **not** `{{expression}}`. Examples: `${name}`, `${$value}`, `${$count}`, `${field | percentOfMax}` inside a Repeat that defines that transform.

**Exception:** optional **`emitTo`** URLs on filter inputs use the literal placeholder **`{{value}}`** for the current control value (client substitution, not formatString).

## Data Sources

A data source is a named collection of rows with typed fields, stored in the Vuex A2UI store per surface.

### Schema

```ts
interface DataSource {
  fields: string[]; // column/field names
  rows: Record<string, unknown>[]; // array of row objects
  primaryKey?: string; // optional key field for incremental merges
}
```

### Pushing data via `updateDataModel`

Include a `$sources` key inside the `data` object of an `updateDataModel` JSONL command. The `$sources` key is extracted and stored separately from the regular data model.

```jsonl
{
  "updateDataModel": {
    "surfaceId": "dash",
    "data": {
      "$sources": {
        "users": {
          "fields": [
            "id",
            "name",
            "role"
          ],
          "rows": [
            {
              "id": "1",
              "name": "Alice",
              "role": "admin"
            },
            {
              "id": "2",
              "name": "Bob",
              "role": "viewer"
            }
          ],
          "primaryKey": "id"
        }
      }
    }
  }
}
```

You can mix regular data model keys alongside `$sources` in the same `updateDataModel`:

```jsonl
{
  "updateDataModel": {
    "surfaceId": "dash",
    "data": {
      "title": "Dashboard",
      "$sources": {
        "users": {
          "fields": [
            "id",
            "name"
          ],
          "rows": []
        }
      }
    }
  }
}
```

### Pushing data via `dataSourcePush` shorthand

The `dataSourcePush` JSONL command is a convenience wrapper that sends sources without needing to nest them under `$sources`. Internally it wraps the payload as `{ $sources: ... }` and calls `updateDataModel`.

```jsonl
{
  "dataSourcePush": {
    "surfaceId": "dash",
    "sources": {
      "users": {
        "fields": [
          "id",
          "name",
          "role"
        ],
        "rows": [
          {
            "id": "1",
            "name": "Alice",
            "role": "admin"
          }
        ],
        "primaryKey": "id"
      }
    }
  }
}
```

### Incremental updates with merge

When an `updateDataModel` is sent with `merge: true` and the data source has a `primaryKey`, existing rows are updated by primary key and new rows are appended. Rows not present in the update are preserved.

```jsonl
{
  "updateDataModel": {
    "surfaceId": "dash",
    "merge": true,
    "data": {
      "$sources": {
        "users": {
          "rows": [
            {
              "id": "1",
              "name": "Alice Updated",
              "role": "admin"
            },
            {
              "id": "3",
              "name": "Charlie",
              "role": "editor"
            }
          ]
        }
      }
    }
  }
}
```

After this merge, the `users` source contains rows for ids 1 (updated), 2 (unchanged), and 3 (new).

---

## Filtering

Filters are driven by interactive components (Select, MultiSelect) via the `bind` property. When a user changes a selection, the bound filter is applied to one or more data sources, and all components reading from those sources update reactively.

### FilterBind schema

```ts
interface FilterBind {
  source: string | string[]; // data source name(s) to filter
  field: string; // field name to filter on
  op?: string; // filter operation (default: "eq")
  nullValue?: unknown; // value that means "no filter" / show all
  emitTo?: string; // optional deep link URL to emit on change
}
```

### Supported filter operations

| Operation  | Description                      | Value type         |
| ---------- | -------------------------------- | ------------------ |
| `eq`       | Exact equality (default)         | `string \| number` |
| `contains` | Case-insensitive substring match | `string`           |
| `gte`      | Greater than or equal            | `number`           |
| `lte`      | Less than or equal               | `number`           |
| `range`    | Value falls within `[lo, hi]`    | `[number, number]` |
| `in`       | Value is in the provided array   | `unknown[]`        |

### Example: Select with filter binding

```jsonl
{
  "updateComponents": {
    "surfaceId": "dash",
    "components": [
      {
        "id": "role-filter",
        "component": "Select",
        "options": [
          {
            "label": "All Roles",
            "value": ""
          },
          {
            "label": "Admin",
            "value": "admin"
          },
          {
            "label": "Viewer",
            "value": "viewer"
          }
        ],
        "selected": "",
        "bind": {
          "source": "users",
          "field": "role",
          "op": "eq",
          "nullValue": ""
        }
      }
    ]
  }
}
```

When the user selects "Admin", only rows where `role === "admin"` pass through. When "All Roles" is selected (value `""`), the filter is inactive because the value matches `nullValue`.

### nullValue concept

`nullValue` defines the "no filter" sentinel. When the current selection equals `nullValue`, the filter is marked as null (`isNull: true`) and excluded from filtering — all rows pass through.

For MultiSelect, `nullValue` can be an array. The comparison checks array equality (same length, same elements in order):

```json
{
  "bind": {
    "source": "users",
    "field": "role",
    "op": "in",
    "nullValue": ["admin", "viewer", "editor"]
  }
}
```

When all options are selected (matching the `nullValue` array), the filter is inactive.

**Empty selection:** When a MultiSelect has no options selected (empty array), the filter is also treated as inactive — all rows pass through. This ensures that clearing a MultiSelect shows all data rather than hiding everything.

### Multi-source filtering

A single filter component can target multiple data sources by providing an array of source names:

```json
{
  "bind": {
    "source": ["users", "audit_log"],
    "field": "role",
    "op": "eq",
    "nullValue": ""
  }
}
```

The filter is applied independently to each named source. Any component bound to either `users` or `audit_log` will reactively update.

---

## Display Binding

Components like Table, Badge, and Text can bind to a data source for dynamic display using the `dataSource` prop.

### DataSourceBinding schema

```ts
interface DataSourceBinding {
  source: string; // data source name
  columns?: string[]; // (Table) which columns to display
  aggregate?: {
    // single aggregate
    fn: "count" | "sum" | "avg" | "min" | "max";
    field?: string; // required for sum/avg/min/max
    format?: "compact"; // optional compact number formatting
  };
  aggregates?: Record<
    string,
    {
      // named compound aggregates
      fn: "count" | "sum" | "avg" | "min" | "max";
      field?: string;
      format?: "compact";
      where?: { field: string; op: string; value: unknown };
    }
  >;
  map?: Record<string, string>; // map aggregate results to component props
}
```

### Aggregates

A single `aggregate` computes one value from the filtered rows:

```json
{
  "dataSource": {
    "source": "orders",
    "aggregate": { "fn": "sum", "field": "total", "format": "compact" }
  }
}
```

- `count` — number of rows (no `field` needed)
- `sum` — sum of numeric field values
- `avg` — average of numeric field values
- `min` / `max` — minimum / maximum of numeric field values

### Compound aggregates

Multiple named aggregates can be computed with optional `where` clauses for inline filtering:

```json
{
  "dataSource": {
    "source": "orders",
    "aggregates": {
      "$total": { "fn": "sum", "field": "amount", "format": "compact" },
      "$pending": { "fn": "count", "where": { "field": "status", "op": "eq", "value": "pending" } }
    },
    "map": { "text": "Total: ${$total} (${$pending} pending)" }
  }
}
```

### Map syntax

The `map` property maps computed values to component props:

- `{ "text": "$value" }` — maps the single `aggregate` result to the `text` prop
- `{ "text": "${$total}" }` — interpolates named compound aggregate keys
- `{ "text": "fieldName" }` — maps a field from the first filtered row to the `text` prop

### Compact number formatting

When `format: "compact"` is set on an aggregate, large numbers are shortened:

| Value     | Formatted |
| --------- | --------- |
| 1,234     | 1.2K      |
| 1,234,567 | 1.2M      |
| 999       | 999       |

---

## Reactive Components

The following components support reactive data binding. See [components.md](components.md) for full props, schemas, and usage examples.

**Filter inputs** (drive filtering via `bind`):

- Select
- MultiSelect
- Checkbox (boolean fields, `op: "eq"`)
- Slider (numeric fields, `op: "gte"`)

**Display binding** (read from data sources via `dataSource`):

- Table
- Badge
- Text
- Repeat (iterates over rows; `dataSource` must use **`source`**, not `name`)

**Repeat template targets** (renderable inside Repeat):

- ProgressBar
- Text
- Badge

**Reactive prop updates** (respond to surface update pushes):

- Accordion (`expanded`)
- Tabs (`active`)

---

## Full Example

A complete dashboard with a data source, filter, table, and summary badges:

```jsonl
{"updateComponents":{"surfaceId":"dash","components":[{"id":"root","component":"Column","children":["title","filter-row","stats-row","user-table"]},{"id":"title","component":"Text","text":"User Dashboard","variant":"h2"},{"id":"filter-row","component":"Row","children":["role-filter","count-badge"]},{"id":"role-filter","component":"Select","options":[{"label":"All Roles","value":""},{"label":"Admin","value":"admin"},{"label":"Viewer","value":"viewer"}],"selected":"","bind":{"source":"users","field":"role","op":"eq","nullValue":""}},{"id":"count-badge","component":"Badge","variant":"info","dataSource":{"source":"users","aggregate":{"fn":"count"},"map":{"text":"$value"}}},{"id":"stats-row","component":"Row","children":["total-badge"]},{"id":"total-badge","component":"Badge","variant":"success","dataSource":{"source":"users","aggregate":{"fn":"count","format":"compact"},"map":{"text":"$value"}}},{"id":"user-table","component":"Table","dataSource":{"source":"users","columns":["name","role","email"]}}]}}
{"dataSourcePush":{"surfaceId":"dash","sources":{"users":{"fields":["name","role","email"],"rows":[{"name":"Alice","role":"admin","email":"alice@example.com"},{"name":"Bob","role":"viewer","email":"bob@example.com"},{"name":"Charlie","role":"admin","email":"charlie@example.com"}],"primaryKey":"name"}}}}
{"createSurface":{"surfaceId":"dash","root":"root"}}
```

This renders a dashboard where selecting a role filters the table and updates the count badge in real time.
