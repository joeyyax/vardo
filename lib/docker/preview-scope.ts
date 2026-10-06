// ---------------------------------------------------------------------------
// Which apps a PR preview covers.
//
// A preview is built for the repo the PR was opened on: the apps built from it,
// their compose children, and whatever those apps declare they depend on.
// Nothing else in the project gets an environment or a deploy.
// ---------------------------------------------------------------------------

/** `github.com/owner/repo`, lowercased, for any https, ssh or scp-style git URL. */
export function normalizeGitRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\/+/, "");
    if (!parsed.hostname || !path) return null;
    return `${parsed.hostname}/${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether an app's git URL points at this GitHub repo (`owner/repo`). */
export function matchesGitHubRepo(gitUrl: string | null | undefined, repoFullName: string): boolean {
  const normalized = normalizeGitRepo(gitUrl);
  return normalized !== null && normalized === `github.com/${repoFullName}`.toLowerCase();
}

export type ScopeApp = {
  id: string;
  name: string;
  gitUrl: string | null;
  parentAppId: string | null;
  dependsOn: string[] | null;
  cloneStrategy: string | null;
};

/**
 * Ids of the apps a preview of `repoFullName` covers, out of one project's apps:
 * the repo's own top-level apps, their transitive `dependsOn` (unless marked
 * `skip`), and every compose child of those.
 */
export function previewScope(projectApps: ScopeApp[], repoFullName: string): Set<string> {
  const byId = new Map(projectApps.map((a) => [a.id, a]));
  const topLevelByName = new Map(
    projectApps.filter((a) => !a.parentAppId).map((a) => [a.name, a]),
  );

  // A matching child previews through its parent; the parent owns the compose file.
  const seeds = new Set<string>();
  for (const app of projectApps) {
    if (!matchesGitHubRepo(app.gitUrl, repoFullName)) continue;
    const root = app.parentAppId ? byId.get(app.parentAppId) : app;
    if (root && !root.parentAppId) seeds.add(root.id);
  }

  const included = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const app = byId.get(queue.shift()!);
    if (!app || included.has(app.id)) continue;
    included.add(app.id);
    for (const depName of app.dependsOn ?? []) {
      const dep = topLevelByName.get(depName);
      if (dep && dep.cloneStrategy !== "skip" && !included.has(dep.id)) queue.push(dep.id);
    }
  }

  for (const app of projectApps) {
    if (app.parentAppId && included.has(app.parentAppId)) included.add(app.id);
  }

  return included;
}
