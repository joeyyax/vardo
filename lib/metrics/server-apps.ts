// App directory for server-scope stats: every app with its organization, project and core flag.

import { db } from "@/lib/db";
import { METRICS_APP_COLUMNS } from "./app-columns";
import { getCoreOrgId } from "./core-org";
import { isCoreApp } from "./core-services";

export async function loadServerApps() {
  const [rows, coreOrgId] = await Promise.all([
    db.query.apps.findMany({
      columns: { ...METRICS_APP_COLUMNS, displayName: true },
      with: {
        organization: { columns: { name: true } },
        project: { columns: { id: true, displayName: true } },
      },
    }),
    getCoreOrgId(),
  ]);

  return rows.map(({ organization, project, ...app }) => ({
    ...app,
    organizationName: organization?.name ?? null,
    projectId: project?.id ?? null,
    projectName: project?.displayName ?? null,
    isCore: isCoreApp(app, coreOrgId),
  }));
}
