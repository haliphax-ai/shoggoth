import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Vite plugin that provides the virtual:shoggoth-catalogs module.
 * This resolves catalog component registrations for the A2UI renderer.
 */
function shoggothCatalogsPlugin(): Plugin {
  const virtualModuleId = "virtual:shoggoth-catalogs";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;

  return {
    name: "shoggoth-catalogs",
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },
    load(id) {
      if (id === resolvedVirtualModuleId) {
        return `
import basicCatalog from "@shoggoth/a2ui-catalog-basic";
import extendedCatalog from "@shoggoth/a2ui-catalog-extended";

const catalogComponents = {};

function registerCatalog(catalog) {
  if (catalog && catalog.components) {
    for (const entry of catalog.components) {
      catalogComponents[entry.name] = { component: entry.component };
    }
  }
}

registerCatalog(basicCatalog);
registerCatalog(extendedCatalog);

export { catalogComponents };
`;
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), vue(), shoggothCatalogsPlugin()],
  base: process.env.VITE_BASE || "/svc/canvas/",
  root: "src/client",
  resolve: {
    alias: {
      "@shoggoth/a2ui-sdk": path.resolve(__dirname, "packages/a2ui-sdk/src/index.ts"),
      "@shoggoth/a2ui-catalog-basic": path.resolve(
        __dirname,
        "packages/a2ui-catalog-basic/src/index.ts",
      ),
      "@shoggoth/a2ui-catalog-extended": path.resolve(
        __dirname,
        "packages/a2ui-catalog-extended/src/index.ts",
      ),
      "@shoggoth/a2ui-catalog-all": path.resolve(
        __dirname,
        "packages/a2ui-catalog-all/src/index.ts",
      ),
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/canvas": "http://127.0.0.1:3000",
      "/scaffold": "http://127.0.0.1:3000",
      "/api": "http://127.0.0.1:3000",
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
      "/gateway": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});
