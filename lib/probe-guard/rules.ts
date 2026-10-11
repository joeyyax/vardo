// Well-known exploit probe paths. Each pattern is RE2 and JS compatible, matched case-insensitively against the request path.

export type ProbeCategory =
  | "secrets"
  | "vcs"
  | "wordpress"
  | "db-admin"
  | "cgi"
  | "framework"
  | "server-info"
  | "backup"
  | "traversal"
  | "router";

export type ProbeRule = {
  id: string;
  category: ProbeCategory;
  /** What was probed, as ban reasons show it. */
  label: string;
  /** 404 for paths whose existence would be worth confirming. */
  status: 403 | 404;
  /** Anchored at the start of the path. */
  pattern: string;
  /** Skipped for WordPress apps. */
  wordpress?: true;
  /** Abuse reporting: "exploit" is reported on sight, "credentials" only as part of a ban. */
  report?: ReportKind;
};

export type ReportKind = "exploit" | "credentials";

export const PROBE_RULES: readonly ProbeRule[] = [
  { id: "dotenv", category: "secrets", label: "env files", status: 404, report: "credentials", pattern: String.raw`^.*/\.env[^/]*$` },
  { id: "aws", category: "secrets", label: "cloud credentials", status: 404, report: "credentials", pattern: String.raw`^.*/\.aws(?:/|$)` },
  { id: "ssh", category: "secrets", label: "SSH keys", status: 404, report: "credentials", pattern: String.raw`^.*/\.ssh(?:/|$)` },
  { id: "editor-sftp", category: "secrets", label: "editor SFTP configs", status: 404, pattern: String.raw`^.*/(?:\.vscode/sftp\.json|sftp-config\.json)$` },
  { id: "htaccess", category: "secrets", label: "Apache access files", status: 404, pattern: String.raw`^.*/\.ht(?:access|passwd)$` },
  { id: "git", category: "vcs", label: "Git metadata", status: 404, pattern: String.raw`^.*/\.git(?:/|$)` },
  { id: "svn-hg", category: "vcs", label: "version control metadata", status: 404, pattern: String.raw`^.*/\.(?:svn|hg|bzr)(?:/|$)` },
  { id: "ds-store", category: "vcs", label: "macOS folder metadata", status: 404, pattern: String.raw`^.*/\.DS_Store$` },
  { id: "wp-login", category: "wordpress", label: "WordPress login", status: 403, wordpress: true, pattern: String.raw`^(?:/(?:wordpress|wp|blog))?/wp-login\.php(?:/|$)` },
  { id: "wp-admin", category: "wordpress", label: "WordPress admin", status: 403, wordpress: true, pattern: String.raw`^(?:/(?:wordpress|wp|blog))?/wp-admin(?:/|$)` },
  { id: "xmlrpc", category: "wordpress", label: "WordPress XML-RPC", status: 403, wordpress: true, pattern: String.raw`^(?:/(?:wordpress|wp|blog))?/xmlrpc\.php(?:/|$)` },
  { id: "phpmyadmin", category: "db-admin", label: "phpMyAdmin", status: 403, pattern: String.raw`^/(?:phpmyadmin[^/]*|pma|myadmin|mysqladmin|adminer\.php)(?:/|$)` },
  { id: "cgi-bin", category: "cgi", label: "CGI scripts", status: 403, pattern: String.raw`^/cgi-bin(?:/|$)` },
  { id: "phpunit", category: "framework", label: "PHPUnit exploit (RCE)", status: 403, report: "exploit", pattern: String.raw`^.*/vendor/phpunit(?:/|$)` },
  { id: "ignition", category: "framework", label: "Laravel Ignition exploit (RCE)", status: 403, report: "exploit", pattern: String.raw`^/_ignition/execute-solution(?:/|$)` },
  // Leaves /actuator/health and /actuator/info alone.
  { id: "actuator", category: "framework", label: "Spring Boot Actuator", status: 403, report: "exploit", pattern: String.raw`^/actuator/(?:env|heapdump|threaddump|configprops|mappings|beans|jolokia|gateway|logfile)(?:/|$)` },
  { id: "actuator-index", category: "framework", label: "Spring Boot Actuator", status: 403, pattern: String.raw`^/actuator/?$` },
  { id: "server-status", category: "server-info", label: "Apache server status", status: 403, pattern: String.raw`^/server-(?:status|info)(?:/|$)` },
  { id: "php-backup", category: "backup", label: "config backups", status: 404, pattern: String.raw`^.*/(?:wp-config|config|configuration|settings|database|db|local)\.php(?:\.bak|\.old|\.orig|\.save|\.swp|\.txt|\.dist|~)$` },
  { id: "wp-config", category: "backup", label: "WordPress config", status: 404, pattern: String.raw`^.*/wp-config\.php$`, wordpress: true },
  { id: "sql-dump", category: "backup", label: "SQL dumps", status: 404, pattern: String.raw`^/(?:backup|dump|db|database|data|site|www|mysql)\.sql(?:\.gz|\.zip|\.bz2)?$` },
  { id: "traversal", category: "traversal", label: "path traversal", status: 403, report: "exploit", pattern: String.raw`^.*/(?:etc/(?:passwd|shadow)|windows/win\.ini|proc/self/environ)$` },
  { id: "router-exploits", category: "router", label: "router exploits", status: 403, report: "exploit", pattern: String.raw`^/(?:boaform|HNAP1|GponForm)(?:/|$)` },
];

export type ProbeMatch = { rule: ProbeRule };

/** The rules that apply to an app. */
export function activeRules(opts: { wordpress: boolean }): ProbeRule[] {
  return PROBE_RULES.filter((r) => !(opts.wordpress && r.wordpress));
}

const compiled = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    compiled.set(pattern, re);
  }
  return re;
}

/** Whether a path starts with one of the exception prefixes, as Traefik's PathPrefix reads them. */
export function isExcepted(path: string, exceptions: readonly string[]): boolean {
  return exceptions.some((e) => path.startsWith(e));
}

/** The first rule a path trips, or null. Mirrors the Traefik rule renderProbeMatcher builds. */
export function matchProbe(
  path: string,
  opts: { wordpress?: boolean; exceptions?: readonly string[] } = {},
): ProbeMatch | null {
  if (opts.exceptions && isExcepted(path, opts.exceptions)) return null;
  for (const rule of activeRules({ wordpress: !!opts.wordpress })) {
    if (regex(rule.pattern).test(path)) return { rule };
  }
  return null;
}

export const OTHER_PROBE_LABEL = "other paths";
/** Rule id counted for hits no rule matches. */
export const OTHER_RULE_ID = "other";

/** The label a rule id counts under; unknown ids count as other paths. */
export function ruleLabel(id: string): string {
  return PROBE_RULES.find((r) => r.id === id)?.label ?? OTHER_PROBE_LABEL;
}

/** What a probed path was after, from the same rules the guard matches. */
export function probeLabel(path: string): string {
  return matchProbe(path)?.rule.label ?? OTHER_PROBE_LABEL;
}

/** One case-insensitive PathRegexp alternation over the rules. */
export function probePathRegexp(rules: readonly ProbeRule[]): string {
  return `(?i)${rules.map((r) => `(?:${r.pattern})`).join("|")}`;
}

const EXCEPTION_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,199}$/;
export const MAX_EXCEPTIONS = 50;

/** Why an exception path is refused, or null. */
export function exceptionProblem(path: string): string | null {
  if (!path.startsWith("/")) return `"${path.slice(0, 60)}" must start with /`;
  if (!EXCEPTION_RE.test(path)) return `"${path.slice(0, 60)}" has characters a path can't`;
  if (path === "/") return "Turn the guard off instead of excepting /";
  return null;
}

/** Path prefixes rendered as Traefik `!PathPrefix` clauses. */
export function exceptionClause(exceptions: readonly string[]): string {
  return exceptions.map((e) => `!PathPrefix(\`${e}\`)`).join(" && ");
}
