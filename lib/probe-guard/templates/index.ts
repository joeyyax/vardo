// The template registry. Add a template by dropping a file here and listing it.

import { actuator } from "./actuator";
import { laravel } from "./laravel";
import { phpmyadmin } from "./phpmyadmin";
import type { ProbeTemplate } from "./types";
import { wordpress } from "./wordpress";

export type { ProbeTemplate, TemplateSignal } from "./types";

export const PROBE_TEMPLATES: readonly ProbeTemplate[] = [wordpress, phpmyadmin, actuator, laravel];

export function findTemplate(id: string): ProbeTemplate | undefined {
  return PROBE_TEMPLATES.find((t) => t.id === id);
}
