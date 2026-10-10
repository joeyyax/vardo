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

/** "4 min", "2 h 4 min": like formatDuration without the seconds once it's past a minute. */
export function formatDurationRough(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return formatDuration(ms);
  return formatDuration(Math.floor(ms / 60_000) * 60_000);
}

/** Seven characters, the length git and GitHub show. */
export function shortSha(sha: string | undefined | null): string {
  return (sha ?? "").slice(0, 7);
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** The commit in a version label: "0.1.0 (bc2083d)" → "bc2083d". A tag or other label comes back as is. */
export function versionShort(label: string): string {
  const inParens = label.match(/\(([0-9a-f]{7,40})\)\s*$/i);
  if (inParens) return shortSha(inParens[1]);
  return SHA_RE.test(label.trim()) ? shortSha(label.trim()) : label;
}

/** Cut to `max` characters at a word, with an ellipsis. */
export function truncate(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.·—-]+$/, "")}…`;
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

/** A stack child's name after its stack's: "Site Audit Runner". Unchanged when it already starts with the stack's. */
export function stackedName(name: string, stack: string | null | undefined): string {
  if (!stack || name.toLowerCase().startsWith(stack.toLowerCase())) return name;
  return `${stack} ${name}`;
}
