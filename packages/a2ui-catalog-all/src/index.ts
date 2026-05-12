/**
 * A2UI Complete Catalog - All UI elements for Shoggoth canvas service
 * Re-exports from basic and extended catalogs
 */

// Re-export everything from basic catalog
export {
  createButton,
  createText,
  createInput,
  ButtonElement,
  TextElement,
  InputElement,
  catalogInfo as basicCatalogInfo,
  catalogInfo,
  CatalogElement as BasicCatalogElement,
} from "@shoggoth/a2ui-catalog-basic";

export type { A2UICommand } from "@shoggoth/a2ui-sdk";

// Re-export everything from extended catalog
export {
  createTable,
  createImage,
  createChart,
  TableElement,
  ImageElement,
  ChartElement,
  catalogInfo as extendedCatalogInfo,
  CatalogElement as ExtendedCatalogElement,
} from "@shoggoth/a2ui-catalog-extended";

// Re-export SDK utilities
export { createCommand, parseCommand, serializeCommand } from "@shoggoth/a2ui-sdk";
export type {
  A2UICommand as Command,
  A2UISurface as Surface,
  A2UIState as State,
  A2UIElement as Element,
} from "@shoggoth/a2ui-sdk";

// Combined catalog info
export const allCatalogInfo = {
  name: "@shoggoth/a2ui-catalog-all",
  version: "0.1.0",
  description: "Complete A2UI catalog for Shoggoth",
  elements: ["button", "text", "input", "table", "image", "chart"] as const,
};

// Combined element type
export type CatalogElement =
  | import("@shoggoth/a2ui-catalog-basic").CatalogElement
  | import("@shoggoth/a2ui-catalog-extended").CatalogElement;
