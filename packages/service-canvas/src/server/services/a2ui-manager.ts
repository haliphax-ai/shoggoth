import { getLogger, deepMerge } from "@shoggoth/shared";
import type { A2UIStore } from "./a2ui-store";

const log = getLogger("service-canvas:a2ui-manager");

/** Plain-object guard matching the semantics of the shared deepMerge helper. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface A2UISurface {
  surfaceId: string;
  session: string;
  /** v0.9 flat shape: value is { component: "Text", text: "..." } (no id) */
  components: Map<string, { component: string; [key: string]: unknown }>;
  root: string | null;
  dataModel: Record<string, unknown>;
  catalogId?: string;
  theme?: string;
}

/** Composite key for session-scoped surfaces */
function key(session: string, surfaceId: string): string {
  return `${session}\0${surfaceId}`;
}

/**
 * Property names that must never be taken from untrusted model payloads.
 * Writing these onto a plain object corrupts lookup/serialization behavior
 * (prototype pollution and method-shadowing), so sanitized merge output
 * silently drops them.
 */
const UNSAFE_KEYS = new Set([
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/**
 * Strip unsafe keys from a model value (recursively for plain objects).
 * Returns the value unchanged when nothing needs to be removed.
 */
function withoutUnsafeKeys(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  let sanitized: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) {
      sanitized ??= { ...value };
      delete sanitized[k];
      continue;
    }
    const cleaned = withoutUnsafeKeys(v);
    if (cleaned !== v && sanitized === null) sanitized = { ...value };
    if (sanitized !== null) sanitized[k] = cleaned;
  }
  return sanitized ?? value;
}

/**
 * Merge a data model update into the existing model.
 *
 * Plain objects merge recursively; arrays, primitives, and other values
 * replace the previous value outright. `$sources` is merged by source name,
 * with each named source replacing its previous definition wholesale —
 * matching the client store's treatment of pushed sources (a push with
 * fewer rows than before must not leave stale rows behind).
 */
export function mergeDataModel(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
  surfaceId?: string,
): Record<string, unknown> {
  const merged = deepMerge(base, withoutUnsafeKeys(update) as Record<string, unknown>);
  const sources = merged.$sources;
  if (isPlainRecord(sources) && isPlainRecord(update.$sources)) {
    for (const [name, src] of Object.entries(update.$sources)) {
      if (UNSAFE_KEYS.has(name)) {
        log.debug("dropping unsafe source name from data model update", {
          surfaceId,
          source: name,
        });
        delete sources[name];
        continue;
      }
      // Per-source wholesale replace mirrors the client store: deep-merged
      // rows would resurrect entries the producer removed, so each named
      // source is taken from the update as-is.
      sources[name] = withoutUnsafeKeys(src);
    }
  }
  return merged;
}

export class A2UIManager {
  private surfaces = new Map<string, A2UISurface>();
  private store: A2UIStore | null;

  constructor(store?: A2UIStore) {
    this.store = store ?? null;
    if (this.store) {
      for (const row of this.store.loadAll()) {
        const componentsObj = JSON.parse(row.components) as Record<
          string,
          { component: string; [key: string]: unknown }
        >;
        const components = new Map(Object.entries(componentsObj));
        this.surfaces.set(key(row.session, row.surfaceId), {
          surfaceId: row.surfaceId,
          session: row.session,
          components,
          root: row.root,
          dataModel: JSON.parse(row.dataModel),
          catalogId: row.catalogId ?? undefined,
          theme: row.theme ?? undefined,
        });
      }
    }
  }

  allSurfaces(): IterableIterator<A2UISurface> {
    return this.surfaces.values();
  }

  surfacesForSession(session: string): A2UISurface[] {
    const result: A2UISurface[] = [];
    for (const s of this.surfaces.values()) {
      if (s.session === session) result.push(s);
    }
    return result;
  }

  upsertSurface(
    session: string,
    surfaceId: string,
    components: Array<{ id: string; component: string; [key: string]: unknown }>,
  ) {
    const k = key(session, surfaceId);
    let surface = this.surfaces.get(k);
    if (!surface) {
      surface = { surfaceId, session, components: new Map(), root: null, dataModel: {} };
      this.surfaces.set(k, surface);
    }
    for (const { id, ...rest } of components) {
      surface.components.set(id, rest as { component: string; [key: string]: unknown });
    }
    this.store?.save(session, surface);
  }

  setRoot(
    session: string,
    surfaceId: string,
    root: string,
    opts?: { catalogId?: string; theme?: string },
  ) {
    const surface = this.surfaces.get(key(session, surfaceId));
    if (surface) {
      surface.root = root;
      if (opts?.catalogId !== undefined) surface.catalogId = opts.catalogId;
      if (opts?.theme !== undefined) surface.theme = opts.theme;
      this.store?.save(session, surface);
    }
  }

  updateDataModel(session: string, surfaceId: string, data: Record<string, unknown>) {
    const surface = this.surfaces.get(key(session, surfaceId));
    if (surface) {
      // Normalize array rows to object rows in $sources
      if (data.$sources && typeof data.$sources === "object") {
        const sources = data.$sources as Record<string, any>;
        for (const [name, src] of Object.entries(sources)) {
          if (src?.rows && Array.isArray(src.rows) && Array.isArray(src.fields)) {
            const fields: string[] = src.fields;
            const hasArrayRows = src.rows.some((r: any) => Array.isArray(r));
            if (hasArrayRows) {
              log.debug("normalizing array rows", { source: name, surfaceId });
              src.rows = src.rows.map((r: any) =>
                Array.isArray(r)
                  ? Object.fromEntries(fields.map((f: string, i: number) => [f, r[i]]))
                  : r,
              );
            }
          }
        }
      }
      surface.dataModel = mergeDataModel(surface.dataModel, data, surfaceId);
      this.store?.save(session, surface);
    }
  }

  deleteSurface(session: string, surfaceId: string) {
    this.surfaces.delete(key(session, surfaceId));
    this.store?.delete(session, surfaceId);
  }

  clearSession(session: string) {
    for (const [k, s] of this.surfaces) {
      if (s.session === session) this.surfaces.delete(k);
    }
    this.store?.clearSession(session);
  }

  clearAll() {
    this.surfaces.clear();
    this.store?.clear();
  }

  getSurface(session: string, surfaceId: string): A2UISurface | undefined {
    return this.surfaces.get(key(session, surfaceId));
  }

  /** Serialize for sending to SPA */
  serialize(session: string, surfaceId: string): Record<string, unknown> | null {
    const s = this.surfaces.get(key(session, surfaceId));
    if (!s) return null;
    const components: Record<string, Record<string, unknown>> = {};
    for (const [id, comp] of s.components) components[id] = comp;
    return {
      surfaceId: s.surfaceId,
      session: s.session,
      components,
      root: s.root,
      dataModel: s.dataModel,
    };
  }
}
