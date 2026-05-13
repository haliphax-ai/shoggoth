# Creating Catalog Packages

This guide covers how to create a third-party A2UI catalog package for the canvas service.

## Overview

A catalog package is an npm package that provides Vue 3 components for A2UI surfaces. Components are discovered at build time by scanning `node_modules/` for packages with a `shoggoth-canvas` field in their `package.json`. They are statically bundled into the SPA — no runtime loading.

The resolution order is:

1. Built-in components (always win)
2. Catalog components (from discovered packages)

Surfaces can restrict available components via `catalogId` (the npm package name of the catalog).

## Prerequisites

Install the SDK as a peer dependency:

```bash
npm install @shoggoth/a2ui-sdk
```

Your `package.json` should declare peer dependencies on Vue 3 and the SDK:

```json
{
  "peerDependencies": {
    "vue": "^3.5.0",
    "@shoggoth/a2ui-sdk": "^0.1.0"
  }
}
```

## Component Contract

Every catalog component is a Vue 3 component that accepts three required props:

| Prop          | Type     | Description                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `def`         | `Object` | The component definition from the JSONL payload (all component-specific props) |
| `surfaceId`   | `String` | The surface this component belongs to                                          |
| `componentId` | `String` | This component's unique ID                                                     |

Components read their configuration from `def` (e.g., `def.text`, `def.variant`, `def.dataSource`).

### Data binding

Use SDK composables to participate in the reactive data system:

| Composable              | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `useDataSource(props)`  | Read filtered rows, aggregated values, mapped props from a data source    |
| `useFilterBind(props)`  | Push filter values to the store (for interactive components like selects) |
| `useOptionsFrom(props)` | Derive option lists from data source fields                               |
| `useSortable(rows)`     | Client-side sort state and toggling                                       |

### Events

Send user interaction events back to the server:

```typescript
import { sendEvent } from "@shoggoth/a2ui-sdk";

sendEvent("a2ui.buttonClick", { componentId: props.componentId });
```

## package.json Convention

Declare your package as a catalog by adding the `shoggoth-canvas` field:

```json
{
  "name": "@example/a2ui-charts",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "shoggoth-canvas": {
    "catalog": "./catalog.json",
    "entry": "./dist/index.js"
  },
  "peerDependencies": {
    "vue": "^3.5.0",
    "@shoggoth/a2ui-sdk": "^0.1.0"
  }
}
```

| Field     | Required | Description                                                      |
| --------- | -------- | ---------------------------------------------------------------- |
| `catalog` | Yes      | Path to the JSON Schema catalog definition file                  |
| `entry`   | Yes      | Path to the ES module that default-exports a `PackageDefinition` |

## catalog.json Format

The catalog definition follows JSON Schema (draft 2020-12) and describes each component's name, description, and prop schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "My Charts Catalog",
  "description": "Chart components for A2UI surfaces",
  "type": "object",
  "components": [
    {
      "name": "BarChart",
      "description": "Vertical bar chart bound to a data source",
      "schema": {
        "type": "object",
        "properties": {
          "valueField": {
            "type": "string",
            "default": "value",
            "description": "Field name for bar values"
          },
          "labelField": {
            "type": "string",
            "default": "label",
            "description": "Field name for bar labels"
          },
          "dataSource": {
            "type": "object",
            "description": "Data source binding"
          }
        }
      }
    }
  ]
}
```

Each entry in `components` must have:

- `name` — matches the component type string used in A2UI JSONL (e.g., `"BarChart"`)
- `description` — human-readable summary
- `schema` — JSON Schema for the component's props (what goes in `def`)

### Schema-driven validation

The server reads component schemas from `catalog.json` at startup and uses them to validate incoming JSONL payloads. This means your catalog schemas are the single source of truth for prop validation — there is no separate hardcoded map.

Validation behavior:

- **Required props** — Use a top-level `"required"` array in the component's schema to mark mandatory props. Missing required props produce errors and the component is rejected.
- **Type checking** — Prop values are checked against their declared `type`. Type mismatches produce errors.
- **Unknown props** — Props not in the schema produce warnings but the component is still accepted.
- **Unknown components** — Components not found in any registered catalog get an "unknown component" warning but pass through.

Example with a required prop:

```json
{
  "name": "BarChart",
  "schema": {
    "type": "object",
    "required": ["dataSource"],
    "properties": {
      "dataSource": { "type": "object", "description": "Data source binding" },
      "valueField": { "type": "string", "default": "value" }
    }
  }
}
```

Meta-catalogs (like `a2ui-catalog-all`) that aggregate sub-catalogs don't need to duplicate schemas — the server resolves schemas from sub-catalog dependencies automatically.

## Entry Point

The entry module default-exports a `PackageDefinition` containing a `ComponentRegistration` array:

```typescript
import type { PackageDefinition } from "@shoggoth/a2ui-sdk";
import BarChart from "./BarChart.vue";

const definition: PackageDefinition = {
  components: [{ name: "BarChart", component: BarChart }],
};

export default definition;
```

Each registration maps a component type name to its Vue 3 implementation. The `name` must match the corresponding entry in `catalog.json`.

## Build Requirements

Catalog packages must ship pre-built ES modules. The canvas server does not compile `.vue` SFCs from dependencies — your `entry` path must point to already-built JavaScript.

For development in the monorepo (via npm workspaces), you can point `entry` directly at source files like `./src/index.ts` since Vite handles compilation. For published packages, point to your `dist/` output.

A typical build setup:

```json
{
  "scripts": {
    "build": "vite build --config vite.config.ts"
  }
}
```

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["vue", "@shoggoth/a2ui-sdk", "vuex"],
    },
  },
});
```

Externalize `vue`, `vuex`, and `@shoggoth/a2ui-sdk` — they're provided by the host application.

## Theme Tokens

The canvas app defines CSS custom properties bridged from DaisyUI's theme system. Use these instead of hardcoding colors so your components adapt to the active theme:

| Token                     | Description                          |
| ------------------------- | ------------------------------------ |
| `--a2ui-primary`          | Primary accent color                 |
| `--a2ui-primary-hover`    | Primary hover state                  |
| `--a2ui-text`             | Base text color                      |
| `--a2ui-text-muted`       | Muted/secondary text                 |
| `--a2ui-bg`               | Base background                      |
| `--a2ui-bg-surface`       | Surface background (cards, panels)   |
| `--a2ui-bg-raised`        | Raised element background            |
| `--a2ui-bg-raised-hover`  | Raised element hover state           |
| `--a2ui-bg-inset`         | Inset/recessed background            |
| `--a2ui-border`           | Border color                         |
| `--a2ui-track`            | Track color (sliders, progress bars) |
| `--a2ui-badge-info-bg`    | Badge info background                |
| `--a2ui-badge-info-fg`    | Badge info foreground                |
| `--a2ui-badge-success-bg` | Badge success background             |
| `--a2ui-badge-success-fg` | Badge success foreground             |
| `--a2ui-badge-warning-bg` | Badge warning background             |
| `--a2ui-badge-warning-fg` | Badge warning foreground             |
| `--a2ui-badge-error-bg`   | Badge error background               |
| `--a2ui-badge-error-fg`   | Badge error foreground               |

DaisyUI utility classes (e.g., `badge-info`, `btn-primary`) also work since the host app includes DaisyUI and Tailwind CSS.

Usage in component styles:

```css
.my-chart {
  color: var(--a2ui-text);
  background: var(--a2ui-bg-surface);
  border: 1px solid var(--a2ui-border);
}

.my-chart-bar {
  background: var(--a2ui-primary);
}

.my-chart-bar:hover {
  background: var(--a2ui-primary-hover);
}
```

## Example: Minimal Catalog Package

Here's a complete example of a catalog package that provides a single `BarChart` component.

### Directory structure

```
my-a2ui-charts/
  package.json
  catalog.json
  src/
    index.ts
    BarChart.vue
```

### package.json

```json
{
  "name": "@example/a2ui-charts",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "shoggoth-canvas": {
    "catalog": "./catalog.json",
    "entry": "./src/index.ts"
  },
  "peerDependencies": {
    "vue": "^3.5.0",
    "@shoggoth/a2ui-sdk": "^0.1.0"
  }
}
```

### catalog.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Example Charts",
  "description": "Chart components for A2UI",
  "type": "object",
  "components": [
    {
      "name": "BarChart",
      "description": "Vertical bar chart bound to a data source",
      "schema": {
        "type": "object",
        "properties": {
          "valueField": { "type": "string", "default": "value" },
          "labelField": { "type": "string", "default": "label" }
        }
      }
    }
  ]
}
```

### src/BarChart.vue

```vue
<template>
  <div class="a2ui-bar-chart">
    <div v-for="(bar, i) in bars" :key="i" class="bar" :style="{ height: bar.pct + '%' }">
      <span class="bar-label">{{ bar.label }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from "vue";
import { useDataSource } from "@shoggoth/a2ui-sdk";

export default defineComponent({
  name: "A2UIBarChart",
  props: {
    def: { type: Object, required: true },
    surfaceId: { type: String, required: true },
    componentId: { type: String, required: true },
  },
  setup(props) {
    const { filteredRows } = useDataSource(props as any);

    const bars = computed(() => {
      const rows = filteredRows.value ?? [];
      const field = (props.def as any).valueField ?? "value";
      const labelField = (props.def as any).labelField ?? "label";
      const max = Math.max(...rows.map((r: any) => Number(r[field]) || 0), 1);
      return rows.map((r: any) => ({
        label: r[labelField] ?? "",
        pct: ((Number(r[field]) || 0) / max) * 100,
      }));
    });

    return { bars };
  },
});
</script>

<style scoped>
.a2ui-bar-chart {
  display: flex;
  gap: 4px;
  align-items: flex-end;
  height: 200px;
}
.bar {
  min-width: 24px;
  border-radius: 4px 4px 0 0;
  background: var(--a2ui-primary);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.bar-label {
  font-size: 0.7em;
  color: var(--a2ui-text);
}
</style>
```

### src/index.ts

```typescript
import type { PackageDefinition } from "@shoggoth/a2ui-sdk";
import BarChart from "./BarChart.vue";

const definition: PackageDefinition = {
  components: [{ name: "BarChart", component: BarChart }],
};

export default definition;
```

### Using it

1. Place the package in `packages/` (for monorepo development) or publish to npm
2. Install it: `npm install @example/a2ui-charts`
3. Restart the dev server — the catalog plugin discovers it automatically
4. Reference the component in A2UI JSONL:

```jsonl
{"createSurface":{"surfaceId":"demo","root":"c1"}}
{"updateComponents":{"surfaceId":"demo","components":[{"id":"c1","component":"BarChart","valueField":"sales","labelField":"month","dataSource":{"source":"monthly"}}]}}
{"dataSourcePush":{"surfaceId":"demo","sources":{"monthly":{"fields":["month","sales"],"rows":[{"month":"Jan","sales":120},{"month":"Feb","sales":200},{"month":"Mar","sales":150}]}}}}
```
