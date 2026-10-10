// Formatting shared by notification subjects and templates.

/** "850 ms", "42 s", "3 min 5 s", "2 h 4 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function shortSha(sha: string | undefined | null): string {
  return (sha ?? "").slice(0, 7);
}

/** Browse URL for a git remote: `git@github.com:a/b.git` → `https://github.com/a/b`. Null for anything else. */
export function repoWebUrl(gitUrl: string | null | undefined): string | null {
  if (!gitUrl) return null;
  const url = gitUrl.trim();
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}

/** Commit page on GitHub, GitLab, Gitea and friends. */
export function commitUrl(repoUrl: string | undefined, sha: string | undefined): string | undefined {
  if (!repoUrl || !sha) return undefined;
  const path = repoUrl.includes("gitlab") ? "-/commit" : "commit";
  return `${repoUrl}/${path}/${sha}`;
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  webhook: "Push",
  api: "API",
  rollback: "Rollback",
};

export function triggerLabel(trigger: string | undefined, by?: string): string | undefined {
  if (!trigger && !by) return undefined;
  const label = trigger ? TRIGGER_LABELS[trigger] ?? trigger : "Manual";
  return by ? `${label} by ${by}` : label;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
