import type { WidgetModule } from "./types";

const modules: WidgetModule[] = [];

export function registerModule(mod: WidgetModule) {
  modules.push(mod);
}

export function getModules(): WidgetModule[] {
  return modules;
}
