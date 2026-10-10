import { appHref, deployHref } from "@/lib/ui/hrefs";
import type { AppTab } from "@/lib/ui/app-tabs";
import type { ClassifiedActivity } from "./types";

const STABILITY_ACTIONS = new Set(["app.crashed", "app.crash_looping", "app.recovered"]);

function tabFor(item: Pick<ClassifiedActivity, "action" | "family">): AppTab | undefined {
  if (STABILITY_ACTIONS.has(item.action)) return "stability";
  if (item.action.startsWith("security.")) return "security";
  if (item.action === "app.env_revealed") return "variables";
  switch (item.family) {
    case "deploy":
      return "deployments";
    case "backup":
      return "backups";
    case "cron":
      return "cron";
    case "domain":
      return "networking";
    default:
      return undefined;
  }
}

/** Where an activity row's subject lives: the tab the action concerns, or the deploy itself. Null without a live app. */
export function subjectHref(item: Pick<ClassifiedActivity, "action" | "family" | "metadata" | "app">): string | null {
  if (!item.app) return null;
  const deploymentId = (item.metadata as { deploymentId?: unknown } | null)?.deploymentId;
  if (item.family === "deploy" && typeof deploymentId === "string" && deploymentId) {
    return deployHref(item.app.name, deploymentId);
  }
  return appHref(item.app.name, tabFor(item));
}
