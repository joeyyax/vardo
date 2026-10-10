import type { AppTab } from "@/lib/ui/app-tabs";

/** Where each entity lives. One place, so a link and its route can't drift. */

export function appHref(name: string, tab?: AppTab, sub?: string): string {
  const base = `/apps/${encodeURIComponent(name)}`;
  if (!tab) return base;
  return sub ? `${base}/${tab}/${encodeURIComponent(sub)}` : `${base}/${tab}`;
}

/** The Deployments tab with that deploy expanded. */
export function deployHref(appName: string, deploymentId: string): string {
  return appHref(appName, "deployments", deploymentId);
}

export function projectHref(name: string): string {
  return `/projects/${encodeURIComponent(name)}`;
}

/** The Security tab, scrolled to one finding when given. */
export function securityHref(appName: string, findingId?: string): string {
  const base = appHref(appName, "security");
  return findingId ? `${base}#${findingAnchor(findingId)}` : base;
}

export function findingAnchor(findingId: string): string {
  return `finding-${findingId}`;
}

export function deployAnchor(deploymentId: string): string {
  return `deploy-${deploymentId}`;
}

/** A domain as a URL. Keeps a scheme that is already there. */
export function siteUrl(domain: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`;
}
