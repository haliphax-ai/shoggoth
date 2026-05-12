/**
 * A2UI Extended Catalog - Advanced UI elements for Shoggoth canvas service
 */

import { A2UIElement, createCommand, A2UICommand } from "@shoggoth/a2ui-sdk";

// Table element
export interface TableElement extends A2UIElement {
  type: "table";
  props: {
    headers: string[];
    rows: string[][];
    striped?: boolean;
    bordered?: boolean;
  };
}

// Image element
export interface ImageElement extends A2UIElement {
  type: "image";
  props: {
    src: string;
    alt?: string;
    width?: number;
    height?: number;
    fit?: "contain" | "cover" | "fill";
  };
}

// Chart element
export interface ChartElement extends A2UIElement {
  type: "chart";
  props: {
    type: "bar" | "line" | "pie" | "doughnut";
    data: {
      labels: string[];
      datasets: Array<{
        label: string;
        data: number[];
        backgroundColor?: string | string[];
        borderColor?: string | string[];
      }>;
    };
    options?: Record<string, unknown>;
  };
}

// Factory functions for creating elements
export function createTable(
  id: string,
  headers: string[],
  rows: string[][],
  options?: { striped?: boolean; bordered?: boolean },
): TableElement {
  return {
    type: "table",
    id,
    props: {
      headers,
      rows,
      striped: options?.striped ?? true,
      bordered: options?.bordered ?? false,
    },
  };
}

export function createImage(
  id: string,
  src: string,
  options?: { alt?: string; width?: number; height?: number; fit?: "contain" | "cover" | "fill" },
): ImageElement {
  return {
    type: "image",
    id,
    props: {
      src,
      alt: options?.alt,
      width: options?.width,
      height: options?.height,
      fit: options?.fit ?? "contain",
    },
  };
}

export function createChart(
  id: string,
  type: "bar" | "line" | "pie" | "doughnut",
  data: {
    labels: string[];
    datasets: Array<{
      label: string;
      data: number[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
    }>;
  },
  options?: Record<string, unknown>,
): ChartElement {
  return {
    type: "chart",
    id,
    props: {
      type,
      data,
      options,
    },
  };
}

// Export all element types
export type CatalogElement = TableElement | ImageElement | ChartElement;

// Catalog metadata
export const catalogInfo = {
  name: "@shoggoth/a2ui-catalog-extended",
  version: "0.1.0",
  description: "Extended A2UI catalog for Shoggoth",
  elements: ["table", "image", "chart"] as const,
};

// Re-export from SDK
export { createCommand, A2UICommand };
