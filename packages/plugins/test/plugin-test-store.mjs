// Module-scoped store for plugin fixture side effects. Test plugin entrypoints
// record hook executions here; tests import this module and inspect the store
// instead of touching globalThis.
export const pluginTestStore = new Map();

/** URL of this module, for fixture entrypoints to import it by absolute path. */
export const pluginTestStoreUrl = import.meta.url;
