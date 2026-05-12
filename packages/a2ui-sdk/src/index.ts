/**
 * A2UI SDK - Types and utilities for Shoggoth canvas service
 */

// Core A2UI Types
export interface A2UICommand {
  id: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface A2UISurface {
  id: string;
  elements: A2UIElement[];
  metadata?: Record<string, unknown>;
}

export interface A2UIState {
  surfaceId: string;
  values: Record<string, unknown>;
}

export interface A2UIElement {
  type: string;
  id: string;
  props: Record<string, unknown>;
}

// Utility Functions
export function parseCommand(raw: string): A2UICommand | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.id && parsed.type && parsed.action) {
      return parsed as A2UICommand;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeCommand(command: A2UICommand): string {
  return JSON.stringify(command);
}

export function createCommand(
  type: string,
  action: string,
  payload: Record<string, unknown> = {},
): A2UICommand {
  return {
    id: crypto.randomUUID(),
    type,
    action,
    payload,
  };
}
