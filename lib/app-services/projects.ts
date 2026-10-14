import { and, asc, desc, eq, inArray, isNull, max, or, sql, type AnyColumn } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/api/error-response";
import { restartCountsByApp } from "@/lib/db/app-restarts";
import { apps, backups, projectInstances, projects } from "@/lib/db/schema";
import { maskGitUrl } from "@/lib/api/git-fields";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { primaryDomain } from "@/lib/ui/app-row";
import type { ProjectsApp, ProjectsProject } from "@/lib/ui/projects";
import { effectiveKind } from "@/lib/ui/service-kind";
import type { MeshPeerSummary, ProjectInstanceSummary } from "@/lib/mesh/types";
import { allows, authorize, type Actor } from "./actor";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors";
import { canImportContainers, listPreferences } from "./viewer";
import { listStars } from "./stars";

const APP_COLUMNS = {
  id: true,
  name: true,
  displayName: true,
  projectId: true,
  status: true,
  parked: true,
  kind: true,
  kindOverride: true,
  conditions: true,
  exitReason: true,
  needsRedeploy: true,
  imageName: true,
  gitUrl: true,
  composeService: true,
  dependsOn: true,
  priority: true,
  gpuEnabled: true,
  containerStartedAt: true,
  lastRunningAt: true,
  statusChangedAt: true,
  createdAt: true,
} as const;

const DEPLOYMENT_COLUMNS = {
  id: true,
  status: true,
  trigger: true,
  gitSha: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  waitReason: true,
  waitingSince: true,
  waitAhead: true,
  waitTotal: true,
} as const;

const PROJECT_APP_SUMMARY = { id: true, name: true, displayName: true, status: true } as const;

/** Matches the id or the name, preferring the id. */
function byRef(table: typeof projects | typeof apps, orgId: string, ref: string) {
  return {
    where: and(eq(table.organizationId, orgId), or(eq(table.id, ref), eq(table.name, ref))),
    orderBy: [sql`(${table.id} = ${ref}) desc`],
  };
}

/** The org's projects, newest first, with each one's apps. */
export async function listProjects(actor: Actor) {
  authorize(actor, "org.view");
  return db.query.projects.findMany({
    where: eq(projects.organizationId, actor.org.id),
    with: { apps: { columns: PROJECT_APP_SUMMARY }, groupEnvironments: true },
    orderBy: [desc(projects.createdAt)],
  });
}

/** One project by id or name, with its apps. */
export async function getProject(actor: Actor, ref: string) {
  authorize(actor, "org.view");
  const project = await db.query.projects.findFirst({
    ...byRef(projects, actor.org.id, ref),
    with: { apps: { columns: PROJECT_APP_SUMMARY } },
  });
  if (!project) throw new NotFoundError("project");
  return project;
}

export const createProjectSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Name must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required").max(100),
  description: z.string().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

export const PROJECT_NAME_TAKEN = "A project with this name already exists";

/** Creates a project in the actor's org. */
export async function createProject(actor: Actor, input: z.input<typeof createProjectSchema>) {
  authorize(actor, "project.manage");
  const parsed = createProjectSchema.safeParse(input);
  if (!parsed.success) throw new InvalidInputError(parsed.error.issues[0]?.message ?? "Check the project fields.");
  const data = parsed.data;
  try {
    const [project] = await db
      .insert(projects)
      .values({
        id: nanoid(),
        organizationId: actor.org.id,
        name: data.name,
        displayName: data.displayName,
        description: data.description ?? null,
        color: data.color || "#6366f1",
      })
      .returning();
    return project;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(PROJECT_NAME_TAKEN);
    throw error;
  }
}

/** Id, name and display name of every project, for pickers. */
export async function listProjectOptions(actor: Actor) {
  authorize(actor, "org.view");
  return db.query.projects.findMany({
    where: eq(projects.organizationId, actor.org.id),
    columns: { id: true, name: true, displayName: true },
  });
}

/** The org's top-level apps shaped for the Projects list, optionally one project's. */
export async function listProjectsApps(actor: Actor, projectId?: string): Promise<ProjectsApp[]> {
  authorize(actor, "app.view");
  const orgId = actor.org.id;
  const appList = await db.query.apps.findMany({
    where: and(
      eq(apps.organizationId, orgId),
      isNull(apps.parentAppId),
      projectId ? eq(apps.projectId, projectId) : undefined,
    ),
    orderBy: [asc(apps.sortOrder), desc(apps.createdAt)],
    columns: APP_COLUMNS,
    with: {
      domains: { columns: { domain: true, isPrimary: true } },
      deployments: {
        columns: DEPLOYMENT_COLUMNS,
        orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
        limit: 3,
      },
      appTags: { with: { tag: { columns: { name: true } } } },
      childApps: {
        columns: APP_COLUMNS,
        with: { domains: { columns: { domain: true, isPrimary: true } } },
      },
    },
  });

  const ids = appList.flatMap((a) => [a.id, ...a.childApps.map((c) => c.id)]);
  const [restarts, lastBackups] = await Promise.all([
    restartCountsByApp(ids),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ appId: backups.appId, at: max(backups.finishedAt) })
          .from(backups)
          .where(and(eq(backups.organizationId, orgId), eq(backups.status, "success"), inArray(backups.appId, ids)))
          .groupBy(backups.appId),
  ]);
  const lastBackupBy = new Map(lastBackups.map((b) => [b.appId, b.at]));

  type Row = (typeof appList)[number] | (typeof appList)[number]["childApps"][number];
  const shape = (a: Row, extra: Pick<ProjectsApp, "deployments" | "services"> & { tags?: string[] }): ProjectsApp => {
    const primary = primaryDomain(a.domains);
    return {
      ...a,
      kind: effectiveKind(a),
      gitUrl: maskGitUrl(a.gitUrl) ?? null,
      domains: primary ? [primary, ...a.domains.map((d) => d.domain).filter((d) => d !== primary)] : [],
      restartCount: restarts.get(a.id) ?? null,
      lastBackupAt: lastBackupBy.get(a.id) ?? null,
      tags: extra.tags ?? [],
      deployments: extra.deployments,
      services: extra.services,
    };
  };

  return appList.map((a) =>
    shape(a, {
      deployments: a.deployments,
      tags: a.appTags.map((t) => t.tag.name),
      services: a.childApps.map((c) => shape(c, { deployments: [], services: [] })),
    }),
  );
}

/** Everything the Projects page renders on first paint. */
export async function loadProjectsPage(actor: Actor) {
  const [apps, projectList, containerImport, teamsEnabled, prefs, stars] = await Promise.all([
    listProjectsApps(actor),
    listProjects(actor),
    canImportContainers(actor),
    isFeatureEnabledAsync("teams"),
    listPreferences(actor),
    listStars(actor),
  ]);
  const projectOptions: ProjectsProject[] = projectList.map((p) => ({
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    isSystemManaged: p.isSystemManaged,
    createdAt: p.createdAt,
  }));
  return { apps, projects: projectOptions, containerImport, teamsEnabled, density: prefs.density, sort: prefs.sort, stars };
}

// Instance admins see every peer. Org admins see the peers bound to their org.
async function visibleMeshPeers(actor: Actor): Promise<MeshPeerSummary[]> {
  if (!actor.instanceAdmin && !allows(actor, "mesh.peers.view")) return [];
  return db.query.meshPeers
    .findMany({
      where: actor.instanceAdmin ? undefined : (p, { eq }) => eq(p.organizationId, actor.org.id),
      columns: { id: true, name: true, type: true, status: true, connectionType: true },
    })
    .then((p) => p as MeshPeerSummary[])
    .catch(() => [] as MeshPeerSummary[]);
}

/** Everything the project detail page renders, by project id or name. */
export async function loadProjectDetail(actor: Actor, ref: string) {
  authorize(actor, "app.view");
  const project = await db.query.projects.findFirst({
    ...byRef(projects, actor.org.id, ref),
    with: {
      apps: {
        columns: {
          id: true,
          name: true,
          displayName: true,
          description: true,
          status: true,
          parked: true,
          containerStartedAt: true,
          containerMemoryLimit: true,
          needsRedeploy: true,
          conditions: true,
          priority: true,
          gpuEnabled: true,
          imageName: true,
          gitUrl: true,
          gitBranch: true,
          deployType: true,
          source: true,
          dependsOn: true,
          parentAppId: true,
          composeService: true,
          containerName: true,
          isSystemManaged: true,
        },
        with: {
          domains: { columns: { domain: true, isPrimary: true } },
          appTags: { with: { tag: true } },
          deployments: {
            columns: {
              id: true,
              status: true,
              trigger: true,
              gitSha: true,
              gitMessage: true,
              durationMs: true,
              log: true,
              postDeployError: true,
              startedAt: true,
              finishedAt: true,
            },
            orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
            limit: 10,
            with: {
              triggeredByUser: {
                columns: { id: true, name: true, image: true },
              },
            },
          },
          // Counted only. Values stay server-side.
          envVars: {
            columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
          },
          childApps: {
            columns: {
              id: true,
              name: true,
              displayName: true,
              composeService: true,
              status: true,
              parked: true,
              containerName: true,
              containerStartedAt: true,
              needsRedeploy: true,
              conditions: true,
              gpuEnabled: true,
              imageName: true,
              dependsOn: true,
              cpuLimit: true,
              memoryLimit: true,
              persistentVolumes: true,
            },
          },
        },
      },
      groupEnvironments: true,
    },
  });
  if (!project) throw new NotFoundError("project");

  const [meshEnabled, loggingEnabled, environmentsEnabled, meshPeers, meshInstances, containerImport, listApps, prefs, stars, restarts] =
    await Promise.all([
      isFeatureEnabledAsync("mesh"),
      isFeatureEnabledAsync("logging"),
      isFeatureEnabledAsync("environments"),
      visibleMeshPeers(actor),
      db.query.projectInstances
        .findMany({
          where: eq(projectInstances.projectId, project.id),
          columns: { id: true, environment: true, gitRef: true, status: true, meshPeerId: true, transferredAt: true },
        })
        .then((i) => i as ProjectInstanceSummary[])
        .catch(() => [] as ProjectInstanceSummary[]),
      canImportContainers(actor),
      listProjectsApps(actor, project.id),
      listPreferences(actor),
      listStars(actor),
      // Stacks and their services both get a row, so both need a figure.
      restartCountsByApp(project.apps.flatMap((a) => [a.id, ...(a.childApps ?? []).map((c) => c.id)])),
    ]);

  const projectApps = project.apps.map((a) => ({
    ...a,
    gitUrl: maskGitUrl(a.gitUrl) ?? null,
    restartCount: restarts.get(a.id) ?? null,
    childApps: a.childApps?.map((c) => ({ ...c, restartCount: restarts.get(c.id) ?? null })),
  }));

  return {
    project: { ...project, apps: projectApps },
    canDelete: allows(actor, "project.delete"),
    containerImport,
    instanceAdmin: actor.instanceAdmin,
    meshEnabled,
    loggingEnabled,
    environmentsEnabled,
    meshPeers: meshEnabled ? meshPeers : [],
    projectInstances: meshEnabled ? meshInstances : [],
    listApps,
    density: prefs.density,
    sort: prefs.sort,
    stars,
  };
}
