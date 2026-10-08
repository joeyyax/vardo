// #886 check for start, restart and recreate, which reuse the running slot's files without a deploy.

import { access } from "fs/promises";
import { join } from "path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, environments, organizations, projects } from "@/lib/db/schema";
import { appBaseDir, appEnvDir } from "@/lib/paths";
import { slotComposeFiles } from "./compose";
import { assertComposeWithinApp } from "./compose-policy";
import { volumePrefix } from "./volume-prefix";

/** Throws DeployBlockedError when an untrusted app's slot reaches outside the app. Leaves the slot's files alone. */
export async function assertSlotWithinApp(opts: {
  appName: string;
  envName: string;
  slotDir: string;
  composeProject: string;
  reuse: "start" | "restart" | "recreate";
}): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.name, opts.appName), isNull(apps.parentAppId)),
    columns: { id: true, organizationId: true, projectId: true },
  });
  const org = app
    ? await db.query.organizations.findFirst({
        where: eq(organizations.id, app.organizationId),
        columns: { trusted: true },
      })
    : null;
  // No row means no trust.
  const orgTrusted = org?.trusted ?? false;
  if (orgTrusted) return;

  const project = app?.projectId
    ? await db.query.projects.findFirst({
        where: eq(projects.id, app.projectId),
        columns: { allowBindMounts: true, allowDockerSocket: true },
      })
    : null;
  const env = app
    ? await db.query.environments.findFirst({
        where: and(eq(environments.appId, app.id), eq(environments.name, opts.envName)),
        columns: { type: true },
      })
    : null;

  const repoDir = join(appBaseDir(opts.appName), "repo");
  const hasRepo = await access(repoDir).then(() => true, () => false);

  await assertComposeWithinApp({
    slotDir: opts.slotDir,
    appDir: appEnvDir(opts.appName, opts.envName),
    repoDir: hasRepo ? repoDir : null,
    newProjectName: opts.composeProject,
    stableVolumePrefix: volumePrefix(opts.appName, opts.envName),
    composeFileArgs: await slotComposeFiles(opts.slotDir),
    orgTrusted,
    // Local environments always allow bind mounts; the socket stays on the project flag.
    projectAllowBindMounts: (project?.allowBindMounts ?? false) || env?.type === "local",
    projectAllowDockerSocket: project?.allowDockerSocket ?? false,
    reuse: opts.reuse,
  });
}
