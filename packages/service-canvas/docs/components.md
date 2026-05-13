# A2UI Component Reference

Components are referenced by ID in the component tree. Each component entry in an `updateComponents` command uses a flat shape:

```json
{ "id": "example", "component": "Text", "text": "Hello", "variant": "h1" }
```

The component type is a string in the `component` field, and props are siblings at the top level.

## Layout Components

### Column

Vertical flex container. Renders children top-to-bottom with an 8px gap.

```json
{ "Column": { "children": ["header", "content", "footer"] } }
```

| Prop       | Type       | Description                         |
| ---------- | ---------- | ----------------------------------- |
| `children` | `string[]` | Ordered list of child component IDs |

### Row

Horizontal flex container. Renders children left-to-right with a 16px gap.

```json
{ "Row": { "children": ["label", "input", "button"] } }
```

| Prop       | Type       | Description                         |
| ---------- | ---------- | ----------------------------------- |
| `children` | `string[]` | Ordered list of child component IDs |

### Stack

Layered container. Children are positioned absolutely on top of each other (z-stacked).

```json
{ "Stack": { "children": ["background", "overlay"] } }
```

| Prop       | Type       | Description                                                     |
| ---------- | ---------- | --------------------------------------------------------------- |
| `children` | `string[]` | Ordered list of child component IDs (later items render on top) |

### Wrap

Flex-wrap container. Children flow left-to-right and wrap onto new lines when they exceed the container width. Useful for groups of buttons, badges, or any set of items that should reflow responsively.

```json
{ "Wrap": { "children": ["btn1", "btn2", "btn3", "btn4"], "gap": "8px" } }
```

| Prop       | Type       | Description                                 |
| ---------- | ---------- | ------------------------------------------- |
| `children` | `string[]` | Ordered list of child component IDs         |
| `gap`      | `string`   | CSS gap between children (default: `"8px"`) |

### Spacer

Flexible space filler. Expands to fill available space in a Row or Column (`flex: 1`). Takes no props.

```json
{ "Spacer": {} }
```

### Divider

Horizontal rule. Renders a 1px border with 8px vertical margin. Takes no props.

```json
{ "Divider": {} }
```

---

## Container Components

### Accordion

Collapsible container with expandable/collapsible panels. Each panel has a clickable header that toggles visibility of its child component.

```json
{
  "Accordion": {
    "panels": [
      { "title": "Section 1", "child": "section-1-content" },
      { "title": "Section 2", "child": "section-2-content" }
    ],
    "mode": "single",
    "expanded": [0]
  }
}
```

| Prop       | Type                                 | Description                                                                                             |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `panels`   | `{ title: string, child: string }[]` | Panel definitions — `title` is the header text, `child` is the component ID to render                   |
| `mode`     | `string`                             | `"single"` (default) — one panel open at a time; `"multi"` — multiple panels can be open simultaneously |
| `expanded` | `number[]`                           | Optional array of panel indices to start expanded (default: all collapsed)                              |

Panel headers display ▶ when collapsed and ▼ when expanded. In `single` mode, opening a panel automatically closes any other open panel. Both `mode` and `expanded` react to prop changes from surface updates, allowing agents to programmatically toggle panels.

### Tabs

Container that organizes child components into switchable tabbed panels.

```json
{
  "Tabs": {
    "tabs": [
      { "label": "Overview", "child": "overview-content" },
      { "label": "Details", "child": "details-content" }
    ],
    "active": 0,
    "position": "top",
    "height": "auto"
  }
}
```

| Prop       | Type                                 | Description                                                                                                                                           |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`     | `{ label: string, child: string }[]` | Tab definitions — `label` is the tab header text, `child` is the component ID to render                                                               |
| `active`   | `number`                             | 0-based index of the initially active tab (default: `0`)                                                                                              |
| `position` | `string`                             | Tab bar placement: `"top"` (default), `"bottom"` (uses DaisyUI `tabs-bottom`), or `"hidden"`                                                          |
| `height`   | `string`                             | Content panel height. `"auto"` (default) sizes to the tallest child; a CSS value (e.g. `"300px"`, `"50vh"`) sets a fixed height with `overflow: auto` |

When `height` is `"auto"`, all tab panels remain in the DOM (inactive panels use `visibility: hidden; position: absolute`) so the content area grows to accommodate the tallest child. When `position` is `"hidden"`, the tab bar is not rendered — useful when tab switching is driven programmatically via surface updates.

The `active` prop reacts to surface updates, allowing agents to switch tabs programmatically. Tab labels wrap to the next line when they overflow.

---

## Display Components

### Text

Text display component. Renders as `<p>` by default, or as heading/span based on `variant`. Supports reactive data binding via **`formatString`**: use **`${expression}`** in strings (not `{{expression}}`).

**Static mode:**

```json
{ "Text": { "text": "Hello world", "variant": "h2" } }
```

**Data source mode (aggregate with map):**

```json
{
  "Text": {
    "dataSource": {
      "source": "orders",
      "aggregate": { "fn": "sum", "field": "total", "format": "compact" },
      "map": { "text": "$value" }
    },
    "variant": "h1"
  }
}
```

**Data source mode (template interpolation in text):**

```json
{
  "Text": {
    "text": "Total: ${$value} across ${$count} orders",
    "variant": "h2",
    "dataSource": {
      "source": "orders",
      "aggregate": { "fn": "sum", "field": "total" },
      "aggregates": { "$count": { "fn": "count" } }
    }
  }
}
```

**Data source mode (row field interpolation):**

```json
{
  "Text": { "text": "Top customer: ${name} (${revenue})", "dataSource": { "source": "customers" } }
}
```

| Prop          | Type                                  | Description                                                                                                                                                                                                      |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | `string \| { literalString: string }` | Static text content. Supports `${field}` placeholders when `dataSource` is set — resolves against the first filtered row. Also supports `${$value}` for single aggregates and `${$key}` for compound aggregates. |
| `variant`     | `string`                              | HTML tag hint: `h1`–`h6`, `body` (→ `<p>`), `label` (→ `<span>`)                                                                                                                                                 |
| `strokeWidth` | `string`                              | CSS text stroke width (e.g. `"1px"`). Renders a black outline for readability over images.                                                                                                                       |
| `dataSource`  | `DataSourceBinding`                   | Bind to a data source for reactive updates                                                                                                                                                                       |

Display priority: `mappedProps.text` > text with **`formatString`** (`${...}`) interpolation > `aggregatedValue` > static `text`.

Template placeholders in `text` are resolved reactively — when the data source changes (new data pushed, filters applied), the text updates automatically. Placeholders resolve against:

- `${$value}` — single aggregate result
- `${$key}` — compound aggregate keys (e.g. `${$count}`, `${$total}`)
- `${field}` — field from the first row of the filtered data source

Map templates (`dataSource.map`) also support `${field}` placeholders resolved against the first row, in addition to `${$key}` aggregate keys.

### Badge

Inline badge with variant styling. Supports static text or data source binding with aggregates.

**Static mode:**

```json
{ "Badge": { "text": "Active", "variant": "success" } }
```

**Data source mode:**

```json
{
  "Badge": {
    "variant": "info",
    "dataSource": {
      "source": "users",
      "aggregate": { "fn": "count" },
      "map": { "text": "${$value} users" }
    }
  }
}
```

| Prop         | Type                | Description                                        |
| ------------ | ------------------- | -------------------------------------------------- |
| `text`       | `string`            | Static display text                                |
| `variant`    | `string`            | `success`, `warning`, `error`, or `info` (default) |
| `dataSource` | `DataSourceBinding` | Bind to a data source                              |

Display priority: `mappedProps.text` > `aggregatedValue` > static `text`.

Map templates support `${$value}` for single aggregates and `${$key}` for compound aggregates:

```json
{
  "Badge": {
    "variant": "success",
    "dataSource": {
      "source": "runs",
      "aggregates": {
        "$count": { "fn": "count", "where": { "field": "status", "op": "eq", "value": "pass" } }
      },
      "map": { "text": "✓ ${$count}" }
    }
  }
}
```

### Icon

Renders a 24×24 viewBox SVG from the built-in icon map or a custom path. Matches the [A2UI basic catalog](https://a2ui.org/specification/v0_9/basic_catalog.json) Icon component: **`name`** is required — either a string from the catalog enum (e.g. `home`, `search`, `settings`, `warning`) or an object `{ "path": "<path d attribute>" }` for a custom glyph.

**Flat `updateComponents` examples:**

```json
{"id": "icon-home", "component": "Icon", "name": "home"}
{"id": "icon-warn", "component": "Icon", "name": "warning", "size": 28, "color": "#fbbf24"}
{"id": "icon-custom", "component": "Icon", "name": {"path": "M12 2L2 7l10 5 10-5-10-5z"}}
```

| Prop    | Type                           | Required | Description                                     |
| ------- | ------------------------------ | -------- | ----------------------------------------------- |
| `name`  | `string` \| `{ path: string }` | Yes      | Built-in icon key or custom SVG path data (`d`) |
| `size`  | `number`                       | No       | Width and height in px (default: `24`)          |
| `color` | `string`                       | No       | Fill color (default: `currentColor`)            |

The renderer treats icons as decorative (`aria-hidden="true"`).

### Image

Displays an image. Supports `shoggoth-canvas://` URLs for canvas-relative paths.

```json
{ "Image": { "src": "shoggoth-canvas://chart.png", "alt": "Sales chart" } }
```

| Prop  | Type     | Required | Description                                                          |
| ----- | -------- | -------- | -------------------------------------------------------------------- |
| `src` | `string` | Yes      | Image URL (supports `shoggoth-canvas://` for canvas file references) |
| `alt` | `string` | No       | Alt text for accessibility                                           |

### ProgressBar

Progress bar with optional reactive data binding. Commonly used inside Repeat templates for dynamic per-row rendering.

**Static mode:**

```json
{ "ProgressBar": { "label": "Upload progress", "value": 75 } }
```

**Data source mode (template interpolation):**

```json
{
  "ProgressBar": {
    "label": "${progress_label}",
    "value": "${progress_value}",
    "dataSource": { "source": "content" }
  }
}
```

**Data source mode (aggregate in label):**

```json
{
  "ProgressBar": {
    "label": "${$count} tasks done",
    "value": "${$value}",
    "dataSource": {
      "source": "tasks",
      "aggregate": { "fn": "avg", "field": "completion" },
      "aggregates": { "$count": { "fn": "count" } }
    }
  }
}
```

| Prop         | Type                | Description                                                                                                                                                                                                                   |
| ------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`      | `number \| string`  | Progress percentage (clamped 0–100). Supports `${field}` placeholders when `dataSource` is set — resolved value is parsed as a number. Also supports `${$value}` for single aggregates and `${$key}` for compound aggregates. |
| `label`      | `string`            | Optional label above the bar. Supports `${field}`, `${$value}`, and `${$key}` placeholders when `dataSource` is set.                                                                                                          |
| `dataSource` | `DataSourceBinding` | Bind to a data source for reactive updates                                                                                                                                                                                    |

Template placeholders in both `label` and `value` are resolved reactively — when the data source changes (new data pushed, filters applied), the progress bar updates automatically. Placeholders resolve against:

- `${$value}` — single aggregate result
- `${$key}` — compound aggregate keys (e.g. `${$count}`, `${$total}`)
- `${field}` — field from the first row of the filtered data source

Inside a Repeat template with transforms:

```json
{
  "Repeat": {
    "dataSource": { "source": "scores" },
    "transforms": { "percentOfMax": { "fn": "percentOfMax" } },
    "template": {
      "ProgressBar": { "label": "${name}: ${score}", "value": "${score | percentOfMax}" }
    }
  }
}
```

### AudioPlayer

Embedded audio with custom play/pause, seek, and volume controls. `url` may be `http(s):` or `shoggoth-canvas://` (session-scoped files).

```json
{ "AudioPlayer": { "url": "https://example.com/audio.mp3", "description": "Episode 1" } }
```

| Prop          | Type      | Description                                    |
| ------------- | --------- | ---------------------------------------------- |
| `url`         | `string`  | Audio source URL                               |
| `description` | `string`  | Optional title or summary                      |
| `autoplay`    | `boolean` | Start playing automatically (default: `false`) |
| `loop`        | `boolean` | Loop playback (default: `false`)               |
| `muted`       | `boolean` | Initially muted (default: `false`)             |

Play/pause controls use presentation-friendly emoji glyphs (e.g. ▶️ / ⏸️) for consistent rendering across platforms.

### Video

HTML5 video with native controls and responsive sizing.

```json
{
  "Video": {
    "url": "https://example.com/clip.mp4",
    "poster": "https://example.com/poster.jpg",
    "controls": true
  }
}
```

| Prop       | Type      | Description                            |
| ---------- | --------- | -------------------------------------- |
| `url`      | `string`  | Video source URL                       |
| `poster`   | `string`  | Image URL shown before playback        |
| `controls` | `boolean` | Show native controls (default: `true`) |
| `autoplay` | `boolean` | Default: `false`                       |
| `loop`     | `boolean` | Default: `false`                       |
| `muted`    | `boolean` | Default: `false`                       |

### Table

Displays tabular data with optional sorting. Scrolls horizontally when content exceeds viewport width.

**Static mode:**

```json
{
  "Table": {
    "headers": ["Name", "Role"],
    "rows": [
      ["Alice", "Admin"],
      ["Bob", "Viewer"]
    ]
  }
}
```

**Data source mode:**

```json
{
  "Table": {
    "dataSource": { "source": "users", "columns": ["name", "role", "email"] },
    "sortable": true
  }
}
```

| Prop         | Type                     | Description                                                        |
| ------------ | ------------------------ | ------------------------------------------------------------------ |
| `headers`    | `string[]`               | Static column headers                                              |
| `rows`       | `unknown[][]`            | Static row data                                                    |
| `dataSource` | `DataSourceBinding`      | Bind to a data source                                              |
| `sortable`   | `boolean`                | Enable click-to-sort on column headers                             |
| `formatters` | `Record<string, string>` | Column display formatters (key = column name, value = format type) |

Built-in format types:

| Format    | Description                                            |
| --------- | ------------------------------------------------------ |
| `boolean` | Displays `✅` for truthy values, `❌` for falsy values |

When using `dataSource`, if `columns` is omitted, all keys from the first row are used as headers. When all rows are filtered out, the table shows column headers with an empty body instead of disappearing.

**Sorting:** When `sortable` is `true`, clicking a column header cycles through: unsorted → ascending (⬆) → descending (⬇) → unsorted. Only one column can be sorted at a time. Sorting operates on raw data values, not display-formatted strings.

### Repeat

Data-driven iteration component. Renders a template component for each row in a filtered data source. The binding object must use **`source`** (the source key string), consistent with Table, Text, and Badge — **`name` is not used**.

```json
{
  "Repeat": {
    "dataSource": { "source": "scores" },
    "template": { "ProgressBar": { "label": "${name}", "value": "${score | percentOfMax}" } },
    "sortable": true,
    "sortField": "score"
  }
}
```

| Prop         | Type                                             | Description                                                         |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------- |
| `dataSource` | `{ source: string, ... }`                        | Data source to iterate over — **`source`** is required (not `name`) |
| `template`   | `Record<string, object>`                         | Component template with `${field}` placeholders                     |
| `transforms` | `Record<string, { fn: string, field?: string }>` | Named transform definitions                                         |
| `emptyText`  | `string`                                         | Text shown when no rows match                                       |
| `sortable`   | `boolean`                                        | Enable a sort direction dropdown above repeated content             |
| `sortField`  | `string`                                         | Field name to sort by (required when `sortable` is `true`)          |

**Sorting:** When `sortable` is `true`, a dropdown appears above the repeated content with options: "Unsorted" (default), "Ascending", and "Descending". Sorting operates on raw data values.

Repeated items are rendered with a 12px vertical gap between them.

---

## Input Components

### Button

Clickable button. Sends an `a2ui.buttonClick` WebSocket message with the component ID when clicked. Supports optional `href` for deep linking.

```json
{ "Button": { "label": "Refresh", "href": "shoggoth://agent?message=Refresh+the+dashboard" } }
```

| Prop    | Type     | Description                                                                                                      |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `label` | `string` | Button text (also accepts `text`; falls back to `"Button"`)                                                      |
| `href`  | `string` | Optional `shoggoth://` or `shoggoth-fileprompt://` URL; triggers on click without the iframe confirmation dialog |

### Checkbox

Toggle checkbox with label. Sends an `a2ui.checkboxChange` WebSocket message with the component ID and checked state on change. Supports optional `bind` for reactive data filtering on boolean fields.

```json
{ "Checkbox": { "label": "Enable notifications", "checked": true } }
```

**With reactive filter binding:**

```json
{
  "Checkbox": {
    "label": "Show active only",
    "checked": false,
    "bind": { "source": "team_members", "field": "active", "op": "eq", "nullValue": false }
  }
}
```

| Prop      | Type         | Description                                                                                                                                                                  |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`   | `string`     | Label text displayed next to the checkbox                                                                                                                                    |
| `checked` | `boolean`    | Initial checked state (default: `false`)                                                                                                                                     |
| `bind`    | `FilterBind` | Optional filter binding. Defaults: `op: "eq"`, `nullValue: false`. When checked, filters rows where `field === true`. When unchecked (`nullValue` match), the filter clears. |

### TextField

Per the [A2UI basic catalog](https://a2ui.org/specification/v0_9/basic_catalog.json): text input with optional multiline (`longText` → `<textarea>`), validation regexp, Checkable `checks`, and `accessibility` hints.

```json
{ "TextField": { "label": "Notes", "value": "", "variant": "longText" } }
```

**Data-bound value (DynamicString):**

```json
{ "TextField": { "label": "Email", "value": { "path": "/user/email" }, "variant": "shortText" } }
```

**Checks (message shown when `condition` is `false`):**

```json
{
  "TextField": {
    "label": "Code",
    "value": "",
    "checks": [{ "condition": { "path": "/form/codeValid" }, "message": "Invalid code" }]
  }
}
```

**`variant`:** `shortText` (default single-line), `longText` (multiline `<textarea>`), `number`, `obscured` (password). **DateTimeInput** covers date and time picking.

**Flat `updateComponents` examples (one field per variant):**

```json
{"id": "tf1", "component": "TextField", "label": "shortText", "variant": "shortText", "value": ""}
{"id": "tf2", "component": "TextField", "label": "longText", "variant": "longText", "value": ""}
{"id": "tf3", "component": "TextField", "label": "number", "variant": "number", "value": "42"}
{"id": "tf4", "component": "TextField", "label": "obscured", "variant": "obscured", "value": ""}
```

| Prop               | Type                                          | Required | Description                                                                                   |
| ------------------ | --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `label`            | `string` \| `{ literalString }` \| `{ path }` | Yes      | Visible label; `path` reads from surface `dataModel`                                          |
| `value`            | `string` \| `{ literalString }` \| `{ path }` | No       | Field value; `path` binds to `dataModel`                                                      |
| `variant`          | `string`                                      | No       | `shortText` (default), `longText` (textarea), `number`, `obscured` (password)                 |
| `validationRegexp` | `string`                                      | No       | HTML `pattern` on single-line inputs (not on `longText`)                                      |
| `checks`           | `{ condition, message }[]`                    | No       | Checkable: `condition` is boolean or `{ path }` to a boolean; failures show `message`         |
| `accessibility`    | `{ label?, description? }`                    | No       | Extra assistive label and hint text (each DynamicString); description renders below the field |
| `placeholder`      | `string`                                      | No       | Optional placeholder (renderer extension)                                                     |

Sends `a2ui.textFieldChange` with `{ componentId, value }` on input. Supports optional `bind` / `emitTo` via `useFilterBind` like other inputs.

### Select

Dropdown select. Can bind to a data source for reactive filtering.

```json
{
  "Select": {
    "options": [
      { "label": "All", "value": "" },
      { "label": "Active", "value": "active" }
    ],
    "selected": "",
    "bind": { "source": "items", "field": "status", "op": "eq", "nullValue": "" }
  }
}
```

| Prop          | Type                                 | Description                         |
| ------------- | ------------------------------------ | ----------------------------------- |
| `options`     | `{ label: string, value: string }[]` | Dropdown options (static)           |
| `optionsFrom` | `object`                             | Dynamic options binding (see below) |
| `selected`    | `string`                             | Currently selected value            |
| `bind`        | `FilterBind`                         | Optional filter binding             |

#### Dynamic options with `optionsFrom`

Instead of hardcoded `options`, derive them from a data source column or a static list:

```json
{
  "Select": {
    "optionsFrom": {
      "source": "team_members",
      "field": "department",
      "includeAll": true,
      "allLabel": "All Divisions"
    },
    "selected": "",
    "bind": { "source": "team_members", "field": "department", "op": "eq", "nullValue": "" }
  }
}
```

| `optionsFrom` field | Type       | Description                                         |
| ------------------- | ---------- | --------------------------------------------------- |
| `source`            | `string`   | Data source name to derive unique values from       |
| `field`             | `string`   | Field name to extract unique values from            |
| `includeAll`        | `boolean`  | Prepend an "All" option with empty string value     |
| `allLabel`          | `string`   | Label for the "All" option (default: `"All"`)       |
| `list`              | `string[]` | Static list of values (alternative to source/field) |

When `optionsFrom` is present, it takes precedence over `options`. Options update reactively when the data source changes.

Sends `a2ui.selectChange` with `{ componentId, value }` on change.

### MultiSelect

Multi-selection dropdown. Alias for Select with `multi: true`. Renders a `<select multiple>` element.

```json
{
  "MultiSelect": {
    "options": [
      { "label": "Pass", "value": "pass" },
      { "label": "Fail", "value": "fail" }
    ],
    "selected": ["pass", "fail"],
    "bind": { "source": "runs", "field": "status", "op": "in", "nullValue": ["pass", "fail"] }
  }
}
```

| Prop       | Type                                 | Description                                         |
| ---------- | ------------------------------------ | --------------------------------------------------- |
| `options`  | `{ label: string, value: string }[]` | Dropdown options                                    |
| `selected` | `string[]`                           | Currently selected values                           |
| `bind`     | `FilterBind`                         | Optional filter binding (typically with `op: "in"`) |

Sends `a2ui.selectChange` with `{ componentId, values }` (array) on change.

**Empty selection:** When a MultiSelect has no options selected (empty array), the filter is treated as inactive — all rows pass through. This ensures clearing a MultiSelect shows all data rather than hiding everything.

The `bind.source` prop accepts an array to filter multiple data sources simultaneously:

```json
{
  "bind": {
    "source": ["runs", "health"],
    "field": "repo",
    "op": "in",
    "nullValue": ["repo1", "repo2"]
  }
}
```

### Slider

Range slider input. Sends an `a2ui.sliderChange` WebSocket message with the component ID and value on change. Supports optional `bind` for reactive data filtering on numeric fields.

```json
{ "Slider": { "label": "Volume", "min": 0, "max": 100, "value": 50 } }
```

**With reactive filter binding:**

```json
{
  "Slider": {
    "label": "Min Score",
    "min": 0,
    "max": 100,
    "value": 0,
    "bind": { "source": "scores", "field": "points", "op": "gte" }
  }
}
```

| Prop    | Type         | Description                                                                                                                                                                     |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` | `string`     | Optional label above the slider                                                                                                                                                 |
| `min`   | `number`     | Minimum value (default: `0`)                                                                                                                                                    |
| `max`   | `number`     | Maximum value (default: `100`)                                                                                                                                                  |
| `value` | `number`     | Current value (default: `0`)                                                                                                                                                    |
| `bind`  | `FilterBind` | Optional filter binding. Defaults: `op: "gte"`, `nullValue: min`. Filters rows where `field >= slider value`. When the slider is at `min`, the filter clears (nullValue match). |

---

## Nesting

All container and layout components render children via `A2UINode`, which recursively resolves any component type from the surface's component map. Containers can be nested freely — a Column can contain Rows, which can contain Columns, Tabs, Accordions, etc.

## Data Source Binding

Components that support `dataSource` can bind to reactive data pushed via `dataSourcePush` or `updateDataModel`. See [a2ui-reactive.md](a2ui-reactive.md) for the full data binding guide, including filter operations, aggregates, transforms, and incremental merges.
