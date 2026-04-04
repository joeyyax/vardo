"use client";

/**
 * PluginDecorator — wraps an existing UI element with plugin decorators.
 *
 * Decorators can prepend, append, or replace children. The "replace" position
 * is only honored when the admin has enabled "Allow plugin component replacement"
 * in system settings. Otherwise it's silently downgraded to "append".
 *
 * Usage:
 * ```tsx
 * <PluginDecorator target="project.header.title" context={{ orgId }}>
 *   <h1>My Project</h1>
 * </PluginDecorator>
 * ```
 */

import { useEffect, useState } from "react";
import type { SlotComponentType, DecoratorPosition } from "@/lib/plugins/manifest";
import { getSlotComponent } from "./component-map";

type DecoratorEntry = {
  pluginId: string;
  position: DecoratorPosition;
  component: SlotComponentType;
  props: Record<string, unknown>;
};

type PluginDecoratorProps = {
  /** The decorator target (e.g. "project.header.title") */
  target: string;
  /** Context variables for template resolution */
  context?: Record<string, string>;
  /** Whether component replacement is allowed (from admin settings) */
  allowReplace?: boolean;
  children: React.ReactNode;
};

export function PluginDecorator({
  target,
  context = {},
  allowReplace = false,
  children,
}: PluginDecoratorProps) {
  const [decorators, setDecorators] = useState<DecoratorEntry[]>([]);

  useEffect(() => {
    fetch(`/api/v1/plugins/decorators?target=${encodeURIComponent(target)}`)
      .then((r) => r.json())
      .then((data) => setDecorators(data.decorators || []))
      .catch(() => {});
  }, [target]);

  if (decorators.length === 0) return <>{children}</>;

  const prepends: DecoratorEntry[] = [];
  const appends: DecoratorEntry[] = [];
  let replacement: DecoratorEntry | null = null;

  for (const dec of decorators) {
    if (dec.position === "replace" && allowReplace) {
      replacement = dec; // Last replace wins
    } else if (dec.position === "prepend") {
      prepends.push(dec);
    } else {
      // "append" or downgraded "replace"
      appends.push(dec);
    }
  }

  // If a replacement is active, render only the replacement
  if (replacement) {
    return <DecoratorComponent entry={replacement} context={context} />;
  }

  return (
    <>
      {prepends.map((dec, i) => (
        <DecoratorComponent key={`pre-${dec.pluginId}-${i}`} entry={dec} context={context} />
      ))}
      {children}
      {appends.map((dec, i) => (
        <DecoratorComponent key={`app-${dec.pluginId}-${i}`} entry={dec} context={context} />
      ))}
    </>
  );
}

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

function DecoratorComponent({
  entry,
  context,
}: {
  entry: DecoratorEntry;
  context: Record<string, string>;
}) {
  const Component = getSlotComponent(entry.component);
  if (!Component) return null;

  const resolvedProps = resolveTemplates(entry.props, context);
  return <Component {...resolvedProps} />;
}
