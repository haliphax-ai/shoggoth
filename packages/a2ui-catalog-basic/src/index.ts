/**
 * A2UI Basic Catalog - Core UI elements for Shoggoth canvas service
 */

import { A2UIElement, createCommand, A2UICommand } from "@shoggoth/a2ui-sdk";

// Button element
export interface ButtonElement extends A2UIElement {
  type: "button";
  props: {
    label: string;
    variant?: "primary" | "secondary" | "danger";
    disabled?: boolean;
    onClick?: string;
  };
}

// Text element
export interface TextElement extends A2UIElement {
  type: "text";
  props: {
    content: string;
    size?: "small" | "medium" | "large";
    color?: string;
  };
}

// Input element
export interface InputElement extends A2UIElement {
  type: "input";
  props: {
    placeholder?: string;
    value?: string;
    type?: "text" | "number" | "email" | "password";
    disabled?: boolean;
  };
}

// Factory functions for creating elements
export function createButton(
  id: string,
  label: string,
  options?: { variant?: "primary" | "secondary" | "danger"; disabled?: boolean; onClick?: string },
): ButtonElement {
  return {
    type: "button",
    id,
    props: {
      label,
      variant: options?.variant ?? "primary",
      disabled: options?.disabled ?? false,
      onClick: options?.onClick,
    },
  };
}

export function createText(
  id: string,
  content: string,
  options?: { size?: "small" | "medium" | "large"; color?: string },
): TextElement {
  return {
    type: "text",
    id,
    props: {
      content,
      size: options?.size ?? "medium",
      color: options?.color,
    },
  };
}

export function createInput(
  id: string,
  options?: {
    placeholder?: string;
    value?: string;
    type?: "text" | "number" | "email" | "password";
    disabled?: boolean;
  },
): InputElement {
  return {
    type: "input",
    id,
    props: {
      placeholder: options?.placeholder,
      value: options?.value,
      type: options?.type ?? "text",
      disabled: options?.disabled ?? false,
    },
  };
}

// Export all element types
export type CatalogElement = ButtonElement | TextElement | InputElement;

// Catalog metadata
export const catalogInfo = {
  name: "@shoggoth/a2ui-catalog-basic",
  version: "0.1.0",
  description: "Basic A2UI catalog for Shoggoth",
  elements: ["button", "text", "input"] as const,
};

// Re-export from SDK
export { createCommand, A2UICommand };
