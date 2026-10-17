import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql, type AnyColumn } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { restartCountsByApp, restartReading } from "@/lib/db/app-restarts";
import { apps, deployments, environments, orgEnvVars, projects, tags } from "@/lib/db/schema";
import { readableApp } from "@/lib/api/readable-app";
import { getFeatureFlags, isFeatureEnabledAsync } from "@/lib/config/features";
import { sharedServiceNames } from "@/lib/docker/compose";
import { loadStabilityHistory } from "@/lib/docker/stability-history";
import { loadLifecycleHistory } from "@/lib/activity/lifecycle";
import { loadTemplates } from "@/lib/templates/load";
import { getInstanceConfig } from "@/lib/system-settings";
import { DEPLOY_WINDOW_DAYS } from "@/lib/ui/deploy-list";
import { allows, authorize, type Actor } from "./actor";
import { NotFoundError } from "./errors";
import { canImportContainers, userDensity } from "./viewer";
import { isStarred } from "./stars";

/** A page of the org's apps, newest first, with the latest deployment, tags and project. */
export async function listApps(actor: Actor, { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) {
  authorize(actor, "app.view");
  const orgId = actor.org.id;
  const [appList, totalResult] = await Promise.all([
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      with: {
        deployments: {
          columns: { id: true, status: true, startedAt: true },
          orderBy: (d, { desc }) => [desc(d.startedAt)],
          limit: 1,
        },
        appTags: { with: { tag: true } },
        project: true,
      },
      orderBy: [desc(apps.createdAt)],
      limit,
      offset,
    }),
    db.select({ count: sql<number>`count(*)::int` }).from(apps).where(eq(apps.organizationId, orgId)),
  ]);
  const reveal = allows(actor, "env.reveal");
  return {
    apps: appList.map((app) => readableApp(app, reveal)),
    total: totalResult[0]?.count ?? 0,
    limit,
    offset,
  };
}

/** One app by id with recent deployments, domains, environments, project and env var keys. */
export async function getApp(actor: Actor, appId: string) {
  authorize(actor, "app.view");
  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, actor.org.id)),
    with: {
      deployments: {
        orderBy: (d, { desc }) => [desc(d.startedAt)],
        limit: 10,
      },
      domains: true,
      envVars: {
        columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
      },
      environments: { columns: { id: true, name: true, type: true, isDefault: true } },
      project: { columns: { id: true, name: true, displayName: true } },
    },
  });
  if (!app) throw new NotFoundError("app");
  return readableApp(app, allows(actor, "env.reveal"));
}

/** Id, name and display name of every app, for pickers. */
export async function listAppOptions(actor: Actor) {
  authorize(actor, "app.view");
  return db.query.apps.findMany({
    where: eq(apps.organizationId, actor.org.id),
    columns: { id: true, name: true, displayName: true },
  });
}

const DETAIL_DEPLOYMENTS = {
  columns: {
    id: true,
    status: true,
    trigger: true,
    gitSha: true,
    gitMessage: true,
    durationMs: true,
    log: true,
    environmentId: true,
    configSnapshot: true,
    rollbackFromId: true,
    postDeployError: true,
    buildPlan: true,
    buildTargetName: true,
    buildOutcome: true,
    buildFallbackReason: true,
    imageTransfer: true,
    imageTransferMs: true,
    imageTransferBytes: true,
    supersededBy: true,
    slot: true,
    startedAt: true,
    finishedAt: true,
    waitReason: true,
    waitingSince: true,
    waitAhead: true,
    waitTotal: true,
    waitEta: true,
    request: true,
    stage: true,
  },
  with: {
    triggeredByUser: {
      columns: { id: true, name: true, image: true },
    },
  },
} as const;

const DETAIL_WITH = {
  deployments: {
    ...DETAIL_DEPLOYMENTS,
    orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
    limit: 10,
  },
  domains: { with: { certCheck: true } },
  environments: true,
  envVars: {
    columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
  },
  appTags: { with: { tag: true } },
  project: {
    columns: { id: true, name: true, displayName: true, color: true },
  },
  childApps: {
    columns: {
      id: true,
      name: true,
      displayName: true,
      composeService: true,
      status: true,
      parked: true,
      imageName: true,
      containerStartedAt: true,
      containerPort: true,
      exposedPorts: true,
      needsRedeploy: true,
    },
    with: {
      domains: { columns: { domain: true, isPrimary: true } },
    },
  },
} as const;

/** Creates the production environment an older app is missing. */
async function ensureProductionEnvironment(app: { id: string; environments: { type: string }[] }) {
  if (app.environments.some((e) => e.type === "production")) return null;
  const [created] = await db
    .insert(environments)
    .values({ id: nanoid(), appId: app.id, name: "production", type: "production", isDefault: true })
    .onConflictDoNothing()
    .returning();
  return created ?? null;
}

/** Everything the app detail page renders, by app name or id. `deploymentId` loads a linked deploy outside the latest ten. */
export async function loadAppDetail(actor: Actor, ref: string, opts: { deploymentId?: string } = {}) {
  authorize(actor, "app.view");
  const orgId = actor.org.id;

  const [app, allTags, allApps, orgVars] = await Promise.all([
    db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), or(eq(apps.name, ref), eq(apps.id, ref))),
      orderBy: [sql`(${apps.id} = ${ref}) desc`],
      with: DETAIL_WITH,
    }),
    db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    }),
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: { id: true, name: true, projectId: true },
    }),
    db.query.orgEnvVars.findMany({
      where: eq(orgEnvVars.organizationId, orgId),
      columns: { key: true },
    }),
  ]);
  if (!app) throw new NotFoundError("app");

  // Every failure and rollback in the stats window loads, so the counts are complete.
  const loaded = new Set(app.deployments.map((d) => d.id));
  const notable = await db.query.deployments.findMany({
    where: and(
      eq(deployments.appId, app.id),
      gte(deployments.startedAt, sql`now() - make_interval(days => ${DEPLOY_WINDOW_DAYS})`),
      or(inArray(deployments.status, ["failed", "rolled_back"]), eq(deployments.trigger, "rollback")),
    ),
    orderBy: [desc(deployments.startedAt)],
    limit: 50,
    ...DETAIL_DEPLOYMENTS,
  });
  for (const d of notable) if (!loaded.has(d.id)) app.deployments.push(d);
  app.deployments.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  // A linked deploy older than the latest ten still opens.
  if (opts.deploymentId && !app.deployments.some((d) => d.id === opts.deploymentId)) {
    const linked = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, opts.deploymentId), eq(deployments.appId, app.id)),
      ...DETAIL_DEPLOYMENTS,
    });
    if (linked) app.deployments.push(linked);
  }

  const created = await ensureProductionEnvironment(app);
  if (created) app.environments.unshift(created);

  const [featureFlags, siblingList, projectList, parentApp, stabilityIncidents, lifecycleEvents, density, restarts, starred] =
    await Promise.all([
      getFeatureFlags(),
      // Sibling apps, with dependsOn for circular dependency checks.
      app.projectId
        ? db.query.apps.findMany({
            where: and(eq(apps.organizationId, orgId), eq(apps.projectId, app.projectId)),
            columns: { id: true, name: true, displayName: true, status: true, dependsOn: true },
          })
        : Promise.resolve([]),
      db.query.projects.findMany({
        where: eq(projects.organizationId, orgId),
        columns: { id: true, name: true, color: true },
      }),
      // Parent app for a compose child's breadcrumb.
      app.parentAppId
        ? db.query.apps
            .findFirst({
              where: and(eq(apps.id, app.parentAppId), eq(apps.organizationId, orgId)),
              columns: { id: true, name: true, displayName: true },
            })
            .then((p) => p ?? null)
        : Promise.resolve(null),
      loadStabilityHistory(app.id),
      loadLifecycleHistory(app.id),
      userDensity(actor),
      restartCountsByApp((app.childApps ?? []).map((c) => c.id)),
      isStarred(actor, "app", app.id),
    ]);

  // Which services a deploy leaves running, for the Services tab to mark.
  const shared = new Set(app.composeContent ? sharedServiceNames(app.composeContent) : []);
  const childApps = app.childApps?.map((child) => ({
    ...child,
    isShared: shared.has(child.composeService ?? child.name),
    restartCount: restarts.get(child.id) ?? null,
  }));

  return {
    app: { ...readableApp(app, allows(actor, "env.reveal")), childApps },
    role: actor.membership.role,
    canDebug: allows(actor, "app.debug"),
    canTerminal: allows(actor, "app.terminal"),
    featureFlags,
    allTags,
    allParentApps: projectList.map((p) => ({ id: p.id, name: p.name, color: p.color || "#6366f1" })),
    allAppNames: allApps.map((a) => a.name),
    orgVarKeys: orgVars.map((v) => v.key),
    siblings: siblingList
      .filter((s) => s.name !== app.name)
      .map((s) => ({ ...s, dependsOn: s.dependsOn as string[] | null })),
    parentApp,
    restarts: restartReading(app),
    stabilityIncidents,
    lifecycleEvents,
    density,
    starred,
  };
}

/** Everything the new-app flow needs on first paint. */
export async function loadNewAppPage(actor: Actor) {
  authorize(actor, "app.create");
  const orgId = actor.org.id;
  const [templatesEnabled, projectList, instanceConfig, containerImportEnabled, lastApp] = await Promise.all([
    isFeatureEnabledAsync("templates"),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true, color: true },
      orderBy: [asc(projects.name)],
    }),
    getInstanceConfig(),
    canImportContainers(actor),
    // Most recently used project, for preselection.
    db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), isNotNull(apps.projectId)),
      columns: { projectId: true },
      orderBy: [desc(apps.createdAt)],
    }),
  ]);
  const templates = templatesEnabled ? await loadTemplates() : [];

  return {
    // Strips non-serializable properties.
    templates: JSON.parse(JSON.stringify(templates)) as typeof templates,
    parentApps: projectList.map((p) => ({ id: p.id, name: p.name, color: p.color || "#6366f1" })),
    baseDomain: actor.org.baseDomain || instanceConfig.baseDomain,
    recentProjectId: projectList.some((p) => p.id === lastApp?.projectId) ? (lastApp?.projectId ?? undefined) : undefined,
    containerImportEnabled,
  };
}
