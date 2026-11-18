import fs from "node:fs";
import path from "node:path";
import type { ComponentSchema, PropType } from "./a2ui-component-schemas";

export interface CatalogEntry {
  packageName: string;
  catalogPath: string;
  entryPath: string;
  componentNames: string[];
  componentSchemas: Record<string, object>;
  dependencies: string[];
}

export class CatalogRegistry {
  private packages = new Map<string, CatalogEntry>();

  discover(projectRoot: string): void {
    this.packages.clear();
    const nodeModules = path.join(projectRoot, "node_modules");
    if (!fs.existsSync(nodeModules)) return;

    const entries = fs.readdirSync(nodeModules, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      if (entry.name.startsWith("@")) {
        const scopeDir = path.join(nodeModules, entry.name);
        const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
        for (const scoped of scopedEntries) {
          if (scoped.name.startsWith(".")) continue;
          const pkgName = `${entry.name}/${scoped.name}`;
          this.tryRegister(nodeModules, pkgName);
        }
      } else {
        this.tryRegister(nodeModules, entry.name);
      }
    }

    this.resolveMetaCatalogs();
  }

  private tryRegister(nodeModules: string, pkgName: string): void {
    const pkgJsonPath = path.join(nodeModules, pkgName, "package.json");
    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    } catch {
      return;
    }

    const field = pkgJson["shoggoth-canvas"] as { catalog?: string; entry?: string } | undefined;
    if (!field || typeof field !== "object") return;
    if (!field.catalog || !field.entry) return;

    const pkgDir = path.join(nodeModules, pkgName);
    const catalogPath = path.resolve(pkgDir, field.catalog);
    const entryPath = path.resolve(pkgDir, field.entry);

    const dependencies = Object.keys(pkgJson.dependencies ?? {}).filter((dep) => dep !== pkgName);

    let componentNames: string[] = [];
    const componentSchemas: Record<string, object> = {};
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      if (Array.isArray(catalog.components)) {
        for (const c of catalog.components) {
          const name = typeof c === "string" ? c : c?.name;
          if (!name) continue;
          componentNames.push(name);
          if (c.schema) componentSchemas[name] = c.schema;
        }
      }
    } catch {
      // Catalog file missing or malformed — register with empty components
    }

    this.packages.set(pkgName, {
      packageName: pkgName,
      catalogPath,
      entryPath,
      componentNames,
      componentSchemas,
      dependencies,
    });
  }

  /**
   * For meta-catalogs that list components without schemas, resolve schemas
   * from their sub-catalog dependencies.
   */
  private resolveMetaCatalogs(): void {
    for (const [, entry] of this.packages) {
      const missing = entry.componentNames.filter((n) => !entry.componentSchemas[n]);
      if (missing.length === 0) continue;

      const depSchemas: Record<string, object> = {};
      for (const dep of entry.dependencies) {
        const depEntry = this.packages.get(dep);
        if (!depEntry) continue;
        Object.assign(depSchemas, depEntry.componentSchemas);
      }

      for (const name of missing) {
        if (depSchemas[name]) entry.componentSchemas[name] = depSchemas[name];
      }
    }
  }

  getPackage(name: string): CatalogEntry | undefined {
    return this.packages.get(name);
  }

  getCatalogComponents(catalogId: string): string[] {
    return this.packages.get(catalogId)?.componentNames ?? [];
  }

  /**
   * Look up the JSON Schema for a component by name across all registered
   * catalogs. Returns the converted ComponentSchema or undefined.
   */
  getComponentSchema(componentName: string): ComponentSchema | undefined {
    for (const [, entry] of this.packages) {
      const jsonSchema = entry.componentSchemas[componentName];
      if (jsonSchema) return jsonSchemaToComponentSchema(jsonSchema);
    }
    return undefined;
  }

  allCatalogs(): { catalogId: string; components: string[] }[] {
    return Array.from(this.packages.entries()).map(([id, entry]) => ({
      catalogId: id,
      components: entry.componentNames,
    }));
  }

  getComponentMap(): Record<string, { packageName: string; importPath: string }> {
    const map: Record<string, { packageName: string; importPath: string }> = {};
    for (const [, entry] of this.packages) {
      for (const name of entry.componentNames) {
        if (!map[name]) {
          map[name] = { packageName: entry.packageName, importPath: entry.entryPath };
        }
      }
    }
    return map;
  }
}

/**
 * Convert a JSON Schema `properties` block into the internal ComponentSchema
 * format used by the JSONL validation routines.
 */
function jsonSchemaToComponentSchema(schema: unknown): ComponentSchema {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props: Record<string, { type: PropType; required?: boolean }> = {};
  const requiredSet = new Set(s.required ?? []);

  if (s.properties) {
    for (const [name, def] of Object.entries(s.properties)) {
      const d = def as { type?: string; oneOf?: unknown[] };
      let type: PropType = "string";

      if (d.oneOf && Array.isArray(d.oneOf)) {
        const types = d.oneOf.map((o: any) => o.type as string).filter(Boolean);
        if (types.includes("string") && types.includes("object")) type = "string|object";
        else if (types.includes("number") && types.includes("string")) type = "number|string";
        else if (types.length) type = types[0] as PropType;
      } else if (d.type) {
        if (d.type === "integer") type = "number";
        else type = d.type as PropType;
      }

      const entry: { type: PropType; required?: boolean } = { type };
      if (requiredSet.has(name)) entry.required = true;
      props[name] = entry;
    }
  }

  return { props };
}
