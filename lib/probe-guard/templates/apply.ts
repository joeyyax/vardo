import { blockProblem } from "../blocks";
import type { AppProbeGuard } from "../settings";
import type { ProbeTemplate } from "./types";

/** The guard with the template's entries added. Entries already there are kept once. */
export function applyTemplate(guard: AppProbeGuard, template: ProbeTemplate): AppProbeGuard {
  const blocks = [...guard.blocks];
  for (const entry of template.turnAway) {
    if (blockProblem(entry)) throw new Error(`Template ${template.id} has a bad entry: ${entry.value}`);
    if (!blocks.some((b) => b.kind === entry.kind && b.value === entry.value)) blocks.push({ ...entry, template: template.id });
  }
  return {
    ...guard,
    exceptions: [...new Set([...guard.exceptions, ...(template.letThrough ?? [])])],
    blocks,
    templates: [...new Set([...guard.templates, template.id])],
  };
}

/** The guard without what the template added. */
export function removeTemplate(guard: AppProbeGuard, template: ProbeTemplate): AppProbeGuard {
  const letThrough = new Set(template.letThrough ?? []);
  return {
    ...guard,
    exceptions: guard.exceptions.filter((e) => !letThrough.has(e)),
    blocks: guard.blocks.filter((b) => b.template !== template.id),
    templates: guard.templates.filter((t) => t !== template.id),
  };
}
