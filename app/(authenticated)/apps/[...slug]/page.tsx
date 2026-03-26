import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { apps, projects, tags, orgEnvVars, environments } from "@/lib/db/schema";
import { getCurrentOrg } from "@/lib/auth/session";
import { eq, and, asc, desc, or, type AnyColumn } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AppDetail } from "./app-detail";
import { getFeatureFlags } from "@/lib/config/features";

const VALID_TABS = ["apps", "deployments", "connect", "variables", "networking", "logs", "volumes", "cron", "terminal", "metrics", "backups"] as const;
type ValidTab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ slug: string[] }>;
};

export default async function AppDetailPage({ params }: PageProps) {
  const { slug } = await params;

  // URL patterns:
  //   /apps/{slug}
  //   /apps/{slug}/{tab}
  //   /apps/{slug}/{tab}/{subView}
  //   /apps/{slug}/{env}
  //   /apps/{slug}/{env}/{tab}
  //   /apps/{slug}/{env}/{tab}/{subView}
  // Disambiguate: if segment 2 is a known tab, it's a tab. Otherwise it's an env name.
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

  // If there's a tab segment that doesn't match, or too many segments, 404
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
        supersededBy: true,
        startedAt: true,
        finishedAt: true,
      },
      with: {
        triggeredByUser: {
          columns: { id: true, name: true, image: true },
        },
      },
    },
    domains: true,
    environments: true,
    envVars: {
      columns: { id: true, key: true, value: true, isSecret: true, createdAt: true, updatedAt: true },
    },
    appTags: {
      with: { tag: true },
    },
    project: {
      columns: { id: true, name: true, displayName: true, color: true },
    },
  } as const;

  // Look up by name (slug) or ID — supports clean URLs like /apps/redis
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

  // Backfill: ensure production environment exists (safe to remove after all apps have been visited)
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

  // Validate environment segment against actual environments
  if (envSegment && !app.environments.some((e) => e.name === envSegment)) {
    notFound();
  }

  // Strip "production" from URL — it's the default, no need to spell it out
  if (envSegment === "production") {
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/apps/${app.name}${tabPath}`);
  }

  // If accessed by ID, redirect to the clean slug URL
  if (appSlug === app.id && appSlug !== app.name) {
    const envPath = envSegment ? `/${envSegment}` : "";
    const tabPath = tab ? `/${tab}` : "";
    redirect(`/apps/${app.name}${envPath}${tabPath}`);
  }

  // Load sibling apps if this app belongs to a project (includes dependsOn for circular dep detection)
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

  // Build project options list from the projects table
  const allProjectsList = await db.query.projects.findMany({
    where: eq(projects.organizationId, orgId),
    columns: { id: true, name: true, color: true },
  });
  const allParentApps = allProjectsList
    .map((p) => ({ id: p.id, name: p.name, color: p.color || "#6366f1" }));

  const featureFlags = await getFeatureFlags();

  // If the requested tab is gated by a disabled feature flag, fall back to default
  const gatedTabs: Record<string, keyof typeof featureFlags> = {
    cron: "cron",
    terminal: "terminal",
  };
  const effectiveTab = tab && gatedTabs[tab] && !featureFlags[gatedTabs[tab]]
    ? "deployments"
    : tab || "deployments";

  return (
    <AppDetail
      app={app}
      orgId={orgId}
      userRole={orgData.membership.role}
      allTags={allTags}
      allParentApps={allParentApps}
      allAppNames={allApps.map((a) => a.name)}
      orgVarKeys={orgVars.map((v) => v.key)}
      siblings={siblings}
      initialTab={effectiveTab}
      initialEnv={envSegment}
      initialSubView={subSegment}
      featureFlags={featureFlags}
    />
  );
}
