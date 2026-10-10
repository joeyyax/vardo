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

/** An image's registry page. Docker Hub for bare names, the registry host otherwise. Null when unparseable. */
export function imageUrl(image: string): string | null {
  const ref = image.split("@")[0].replace(/:[^/:]+$/, "");
  if (!ref || /\s/.test(ref)) return null;
  const parts = ref.split("/");
  const hasHost = (parts.length > 1 && /[.:]/.test(parts[0])) || parts[0] === "localhost";
  if (hasHost) return parts[0] === "localhost" || parts[0].includes(":") ? null : `https://${ref}`;
  if (parts.length === 1 || parts[0] === "library") return `https://hub.docker.com/_/${parts[parts.length - 1]}`;
  return `https://hub.docker.com/r/${parts.join("/")}`;
}

/** A domain as a URL. Keeps a scheme that is already there. */
export function siteUrl(domain: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`;
}
