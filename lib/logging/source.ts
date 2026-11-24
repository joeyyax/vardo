// Where an app's logs are read from: VictoriaLogs, or its containers through Docker.

import { listContainers } from "@/lib/docker/client";
import { LOG_ACCOUNT_LABEL } from "./account";
import { isVictoriaLogsAvailable } from "./victorialogs";

export type LogSource = "victorialogs" | "docker";

/**
 * VictoriaLogs once every running container of the app carries its log account.
 * A container deployed before log accounts ships to the unassigned tenant until its next deploy.
 */
export async function appLogSource(
  app: { id: string; name: string },
  environment?: string,
  deps: { available?: () => Promise<boolean>; containers?: typeof listContainers } = {},
): Promise<LogSource> {
  if (!(await (deps.available ?? isVictoriaLogsAvailable)())) return "docker";
  const containers = await (deps.containers ?? listContainers)(app, environment).catch(() => []);
  return containers.every((c) => !!c.labels?.[LOG_ACCOUNT_LABEL]) ? "victorialogs" : "docker";
}
