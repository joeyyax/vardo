import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { restartCountsByApp, restartReading } from "@/lib/db/app-restarts";
import { apps, deployments, projects, tags, orgEnvVars, environments } from "@/lib/db/schema";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { getUserPreferences, DEFAULT_PREFERENCES } from "@/lib/user/preferences";
import { eq, and, asc, desc, gte, inArray, or, sql, type AnyColumn } from "drizzle-orm";
import { DEPLOY_WINDOW_DAYS } from "@/lib/ui/deploy-list";
import { nanoid } from "nanoid";
import { AppDetail } from "./app-detail";
import { getFeatureFlags } from "@/lib/config/features";
import { sharedServiceNames } from "@/lib/docker/compose";
import { loadStabilityHistory } from "@/lib/docker/stability-history";
import { loadLifecycleHistory } from "@/lib/activity/lifecycle";

import { can } from "@/lib/auth/permissions";
import { readableApp } from "@/lib/api/readable-app";
import {
  APP_TABS as VALID_TABS,
  type AppTab as ValidTab,
  resolveAppTab,
  rootAppTab,
} from "@/lib/ui/app-tabs";

type PageProps = {
  params: Promise<{ slug: string[] }>;
};

export default async function AppDetailPage({ params }: PageProps) {
  const { slug } = await params;

  // /apps/{slug}[/{env}][/{tab}[/{subView}]]. Segment 2 is a tab if it names one, otherwise an env.
  const appSlug = slug[0];
  let envSegment: string | undefined;
  let tabSegment: string | undefined;
  let subSegment: string | undefined;

  if (slug.length >= 2) {
    if (VALID_TABS.includes(slug[1] as ValidTab)) {
      // /apps/{slug}/{tab}/...
      tabSegment = slug[1];
      subSegment = slug[2];
    } else {
      // /apps/{slug}/{env}/...
      envSegment = slug[1];
      if (slug.length >= 3) {
        if (VALID_TABS.includes(slug[2] as ValidTab)) {
          tabSegment = slug[2];
          subSegment = slug[3];
        } else {
          notFound();
        }
      }
    }
  }

  const tab: ValidTab | undefined = tabSegment && VALID_TABS.includes(tabSegment as ValidTab)
    ? (tabSegment as ValidTab)
    : undefined;

  // Unknown tab or too many segments 404s.
  if (tabSegment && !tab) {
    notFound();
  }
  if (slug.length > 4) {
    notFound();
  }

  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;

  const appWith = {
    deployments: {
      orderBy: (d: { startedAt: AnyColumn }) => [desc(d.startedAt)],
      limit: 10,
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
        supersededBy: true,
        slot: true,
        startedAt: true,
        finishedAt: true,
      },
      with: {
        triggeredByUser: {
          columns: { id: true, name: true, image: true },
        },
      },
    },
    domains: { with: { certCheck: true } },
    environments: true,
    envVars: {
      columns: { id: true, key: true, isSecret: true, createdAt: true, updatedAt: true },
    },
    appTags: {
      with: { tag: true },
    },
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

  // Looks up by name or ID.
  // The organization predicate scopes this, not the global name index.
  const [app, allTags, allApps, orgVars] = await Promise.all([
    db.query.apps.findFirst({
      where: and(
        eq(apps.organizationId, orgId),
        or(eq(apps.name, appSlug), eq(apps.id, appSlug)),
      ),
      with: appWith,
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

  if (!app) {
    notFound();
  }

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
    columns: appWith.deployments.columns,
    with: appWith.deployments.with,
  });
  for (const d of notable) if (!loaded.has(d.id)) app.deployments.push(d);
  app.deployments.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  // A linked deploy older than the latest ten still opens.
  if (tab === "deployments" && subSegment && !app.deployments.some((d) => d.id === subSegment)) {
    const linked = await db.query.deployments.findFirst({
      where: and(eq(deployments.id, subSegment), eq(deployments.appId, app.id)),
      columns: appWith.deployments.columns,
      with: appWith.deployments.with,
    });
    if (linked) app.deployments.push(linked);
  }

  // Backfills a missing production environment. Safe to remove once every app has been visited.
  if (!app.environments.some((e) => e.type === "production")) {
    const [created] = await db
      .insert(environments)
      .values({
        id: nanoid(),
        appId: app.id,
        name: "production",
        type: "production",
        isDefault: true,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      app.environments.unshift(created);
    }
  }

  const featureFlags = await getFeatureFlags();

  if (envSegment && !app.environments.some((e) => e.name === envSegment)) {
    notFound();
  }

  // Production is the default, so it's stripped from the URL.
  // With environments off, every env segment collapses to it.
  if (envSegment === "production" || (envSegment && !featureFlags.environments)) {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/apps/${app.name}${tabPath}`);
  }

  // Redirects ID URLs to the slug URL.
  if (appSlug === app.id && appSlug !== app.name) {
    const envPath = envSegment ? `/${envSegment}` : "";
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/apps/${app.name}${envPath}${tabPath}`);
  }

  // Sibling apps, with dependsOn for circular dependency checks.
  let siblings: {
    id: string;
    name: string;
    displayName: string;
    status: string;
    dependsOn: string[] | null;
  }[] = [];
  if (app.projectId) {
    const siblingList = await db.query.apps.findMany({
      where: and(
        eq(apps.organizationId, orgId),
        eq(apps.projectId, app.projectId),
      ),
      columns: {
        id: true,
        name: true,
        displayName: true,
        status: true,
        dependsOn: true,
      },
    });
    siblings = siblingList
      .filter((s) => s.name !== app.name)
      .map((s) => ({
        ...s,
        dependsOn: s.dependsOn as string[] | null,
      }));
  }

  const allProjectsList = await db.query.projects.findMany({
    where: eq(projects.organizationId, orgId),
    columns: { id: true, name: true, color: true },
  });
  const allParentApps = allProjectsList
    .map((p) => ({ id: p.id, name: p.name, color: p.color || "#6366f1" }));

  // Parent app for a compose child's breadcrumb.
  let parentApp: { id: string; name: string; displayName: string } | null = null;
  if (app.parentAppId) {
    parentApp = await db.query.apps.findFirst({
      where: and(eq(apps.id, app.parentAppId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, displayName: true },
    }) ?? null;
  }

  const tabContext = {
    isComposeParent: (app.childApps?.length ?? 0) > 0,
    isChildService: !!app.parentAppId,
    hasConnectionInfo: (app.connectionInfo?.length ?? 0) > 0,
    canDebug: can(orgData.membership, "app.debug"),
    canTerminal: can(orgData.membership, "app.terminal"),
    features: featureFlags,
  };
  const effectiveTab = resolveAppTab(tab, tabContext);

  const session = await getSession();
  const [stabilityIncidents, lifecycleEvents, prefs] = await Promise.all([
    loadStabilityHistory(app.id),
    loadLifecycleHistory(app.id),
    session?.user?.id ? getUserPreferences(session.user.id) : Promise.resolve(DEFAULT_PREFERENCES),
  ]);

  // Which services a deploy leaves running, for the Services tab to mark.
  const shared = new Set(app.composeContent ? sharedServiceNames(app.composeContent) : []);
  const restarts = await restartCountsByApp((app.childApps ?? []).map((c) => c.id));
  const childApps = app.childApps?.map((child) => ({
    ...child,
    isShared: shared.has(child.composeService ?? child.name),
    restartCount: restarts.get(child.id) ?? null,
  }));

  // Fell back to the default — put that in the URL.
  if (tab && tab !== effectiveTab) {
    const envPath = envSegment ? `/${envSegment}` : "";
    const tabPath = effectiveTab === rootAppTab(tabContext) ? "" : `/${effectiveTab}`;
    redirect(`/apps/${app.name}${envPath}${tabPath}`);
  }

  return (
    <AppDetail
      app={{ ...readableApp(app, can(orgData.membership, "env.reveal")), childApps }}
      orgId={orgId}
      userRole={orgData.membership.role}
      allTags={allTags}
      allParentApps={allParentApps}
      allAppNames={allApps.map((a) => a.name)}
      orgVarKeys={orgVars.map((v) => v.key)}
      siblings={siblings}
      restarts={restartReading(app)}
      stabilityIncidents={stabilityIncidents}
      lifecycleEvents={lifecycleEvents}
      initialTab={effectiveTab}
      initialEnv={envSegment}
      initialSubView={subSegment}
      featureFlags={featureFlags}
      parentApp={parentApp}
      density={prefs.density}
    />
  );
}
