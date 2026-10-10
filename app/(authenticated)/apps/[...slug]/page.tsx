import { redirect, notFound } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadAppDetail } from "@/lib/app-services/apps";
import { AppDetail } from "./app-detail";
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

  const actor = await currentActor();
  if (!actor) {
    redirect("/login");
  }

  const data = await pageData(
    loadAppDetail(actor, appSlug, { deploymentId: tab === "deployments" ? subSegment : undefined }),
  );
  const { app, featureFlags } = data;

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

  const tabContext = {
    isComposeParent: (app.childApps?.length ?? 0) > 0,
    isChildService: !!app.parentAppId,
    hasConnectionInfo: (app.connectionInfo?.length ?? 0) > 0,
    canDebug: data.canDebug,
    canTerminal: data.canTerminal,
    features: featureFlags,
  };
  const effectiveTab = resolveAppTab(tab, tabContext);

  // Fell back to the default — put that in the URL.
  if (tab && tab !== effectiveTab) {
    const envPath = envSegment ? `/${envSegment}` : "";
    const tabPath = effectiveTab === rootAppTab(tabContext) ? "" : `/${effectiveTab}`;
    redirect(`/apps/${app.name}${envPath}${tabPath}`);
  }

  return (
    <AppDetail
      app={app}
      orgId={actor.org.id}
      userRole={data.role}
      allTags={data.allTags}
      allParentApps={data.allParentApps}
      allAppNames={data.allAppNames}
      orgVarKeys={data.orgVarKeys}
      siblings={data.siblings}
      restarts={data.restarts}
      stabilityIncidents={data.stabilityIncidents}
      lifecycleEvents={data.lifecycleEvents}
      initialTab={effectiveTab}
      initialEnv={envSegment}
      initialSubView={subSegment}
      featureFlags={featureFlags}
      parentApp={data.parentApp}
      density={data.density}
    />
  );
}
