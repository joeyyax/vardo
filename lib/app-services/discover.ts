import { listProjectOptions } from "./projects";
import { canImportContainers } from "./viewer";
import type { Actor } from "./actor";

/** The discover page's projects to import into, or null when the actor can't import containers. */
export async function loadDiscoverPage(actor: Actor) {
  if (!(await canImportContainers(actor))) return null;
  return { projects: await listProjectOptions(actor) };
}
