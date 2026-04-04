import type { SlotComponentType } from "@/lib/plugins/manifest";
import type { ComponentType } from "react";

import { DataTable } from "./data-table";
import { FormSection } from "./form-section";

// ---------------------------------------------------------------------------
// Inline slot components — small enough to live here rather than in their
// own files. DataTable and FormSection are imported from dedicated modules.
// ---------------------------------------------------------------------------

// These are defined in slot-renderer.tsx and re-exported here so both
// slot-renderer and decorator-renderer share the same registry.
// Lazy re-export: the actual component definitions live in slot-renderer
// to keep them colocated with the PluginSlots component that renders them.
// We import them dynamically at registration time below.

// For components that need to remain inline (too simple for their own file),
// we accept them as registrations from slot-renderer.

const registry = new Map<SlotComponentType, ComponentType<Record<string, unknown>>>();

// Register the two new components immediately
registry.set("data-table", DataTable as ComponentType<Record<string, unknown>>);
registry.set("form-section", FormSection as ComponentType<Record<string, unknown>>);

/**
 * Register an inline slot component. Called by slot-renderer during module init
 * so the simple components (status-badge, metric-card, etc.) don't need their
 * own files but are still available to decorator-renderer.
 */
export function registerSlotComponent(
  type: SlotComponentType,
  component: ComponentType<Record<string, unknown>>,
) {
  registry.set(type, component);
}

/**
 * Look up a slot component by type string.
 */
export function getSlotComponent(
  type: SlotComponentType,
): ComponentType<Record<string, unknown>> | undefined {
  return registry.get(type);
}

/**
 * Full component map as a plain object — for cases where you need
 * all entries at once (e.g. iterating). Prefer getSlotComponent()
 * for single lookups.
 */
export function getComponentMap(): Record<SlotComponentType, ComponentType<Record<string, unknown>>> {
  return Object.fromEntries(registry) as Record<
    SlotComponentType,
    ComponentType<Record<string, unknown>>
  >;
}
