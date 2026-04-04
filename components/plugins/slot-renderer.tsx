"use client";

/**
 * PluginSlots — renders plugin UI declarations for a given slot location.
 *
 * Reads enabled plugin manifests, filters for the requested slot,
 * and renders the declared component type with its props.
 *
 * Plugins feel native — same components, same design system. The user
 * doesn't know or care whether a tab/badge/card is core or plugin.
 */

import { useEffect, useState } from "react";
import type { SlotLocation, SlotComponentType } from "@/lib/plugins/manifest";

type SlotEntry = {
  pluginId: string;
  component: SlotComponentType;
  props: Record<string, unknown>;
};

type PluginSlotsProps = {
  /** Which slot location to render (e.g. "app.detail.tabs") */
  location: SlotLocation;
  /** Context variables for URL template resolution (e.g. { orgId, appId }) */
  context?: Record<string, string>;
};

/**
 * Resolve template variables in props.
 * Replaces `{orgId}`, `{appId}`, etc. in string values.
 */
function resolveTemplates(
  props: Record<string, unknown>,
  context: Record<string, string>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string") {
      let str = value;
      for (const [varName, varValue] of Object.entries(context)) {
        str = str.replace(new RegExp(`\\{${varName}\\}`, "g"), varValue);
      }
      resolved[key] = str;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Component type registry — maps manifest component types to React components
// ---------------------------------------------------------------------------

function StatusBadge({ label, statusField }: { label: string; statusField?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      {label}
    </span>
  );
}

function MetricCard({ title, metric, icon }: { title: string; metric?: string; icon?: string }) {
  return (
    <div className="squircle border bg-card p-4">
      <div className="text-sm font-medium text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-bold">—</div>
    </div>
  );
}

function ActionButton({ label, icon, action }: { label: string; icon?: string; action?: string }) {
  return (
    <button
      className="squircle inline-flex items-center gap-2 border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent"
      onClick={() => action && window.open(action, "_blank")}
    >
      {label}
    </button>
  );
}

function KeyValueRow({ label, valueSource }: { label: string; valueSource?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span>—</span>
    </div>
  );
}

function InlineAlert({ message, variant }: { message: string; variant?: string }) {
  return (
    <div className={`rounded-md px-3 py-2 text-xs ${variant === "warning" ? "bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200" : "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200"}`}>
      {message}
    </div>
  );
}

function PluginLink({ label, href }: { label: string; href?: string }) {
  return (
    <a href={href || "#"} className="text-sm text-primary hover:underline">
      {label}
    </a>
  );
}

function PluginIframe({ src, height }: { src?: string; height?: number }) {
  return (
    <div className="squircle overflow-hidden border">
      <div className="bg-muted px-2 py-1 text-xs text-muted-foreground">Plugin content</div>
      <iframe
        src={src}
        className="w-full border-0"
        style={{ height: height || 400 }}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}

// Map component type strings to React components
const COMPONENT_MAP: Record<SlotComponentType, React.ComponentType<Record<string, unknown>>> = {
  "status-badge": StatusBadge as React.ComponentType<Record<string, unknown>>,
  "metric-card": MetricCard as React.ComponentType<Record<string, unknown>>,
  "data-table": MetricCard as React.ComponentType<Record<string, unknown>>, // placeholder
  "form-section": MetricCard as React.ComponentType<Record<string, unknown>>, // placeholder
  "action-button": ActionButton as React.ComponentType<Record<string, unknown>>,
  "key-value-row": KeyValueRow as React.ComponentType<Record<string, unknown>>,
  "inline-alert": InlineAlert as React.ComponentType<Record<string, unknown>>,
  "link": PluginLink as React.ComponentType<Record<string, unknown>>,
  "iframe": PluginIframe as React.ComponentType<Record<string, unknown>>,
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PluginSlots({ location, context = {} }: PluginSlotsProps) {
  const [slots, setSlots] = useState<SlotEntry[]>([]);

  useEffect(() => {
    // Fetch enabled plugin slot declarations for this location
    fetch(`/api/v1/plugins/slots?location=${encodeURIComponent(location)}`)
      .then((r) => r.json())
      .then((data) => setSlots(data.slots || []))
      .catch(() => {}); // No plugins = no slots, silent
  }, [location]);

  if (slots.length === 0) return null;

  return (
    <>
      {slots.map((slot, i) => {
        const Component = COMPONENT_MAP[slot.component];
        if (!Component) return null;
        const resolvedProps = resolveTemplates(slot.props, context);
        return <Component key={`${slot.pluginId}-${i}`} {...resolvedProps} />;
      })}
    </>
  );
}

/**
 * Server-side slot resolution — for use in server components.
 * Returns the slot entries without rendering them.
 */
export async function getPluginSlots(location: SlotLocation): Promise<SlotEntry[]> {
  try {
    const { getEnabledPlugins } = await import("@/lib/plugins/registry");
    const plugins = await getEnabledPlugins();

    const entries: SlotEntry[] = [];
    for (const plugin of plugins) {
      const slotDecl = plugin.ui?.slots?.[location];
      if (slotDecl) {
        entries.push({
          pluginId: plugin.id,
          component: slotDecl.component,
          props: slotDecl.props,
        });
      }
    }

    return entries;
  } catch {
    return [];
  }
}
