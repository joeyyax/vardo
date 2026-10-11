import { describe, expect, it } from "vitest";
import { PROBE_RULES, exceptionProblem, isExcepted, matchProbe, probePathRegexp } from "@/lib/probe-guard/rules";

const PROBES = [
  "/.env", "/.env.local", "/.env.production", "/api/.env", "/.envrc",
  "/.git/config", "/.git/HEAD", "/sub/.git/", "/.git",
  "/.svn/entries", "/.hg/store", "/.DS_Store", "/assets/.DS_Store",
  "/wp-login.php", "/wp-admin/", "/wp-admin", "/wordpress/wp-admin/setup-config.php", "/xmlrpc.php",
  "/phpmyadmin/", "/phpMyAdmin/index.php", "/pma", "/pma/", "/myadmin/",
  "/cgi-bin/luci", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/lib/vendor/phpunit/x",
  "/.aws/credentials", "/.ssh/id_rsa",
  "/actuator", "/actuator/env", "/actuator/heapdump",
  "/server-status", "/server-info",
  "/config.php.bak", "/wp-config.php.old", "/wp-config.php~", "/settings.php.save", "/wp-config.php",
  "/backup.sql", "/dump.sql.gz",
  "/etc/passwd", "/static/etc/passwd", "/a/b/etc/shadow",
  "/boaform/admin/formLogin", "/HNAP1/", "/HNAP1", "/GponForm/diag_Form",
  "/.htaccess", "/sftp-config.json", "/.vscode/sftp.json", "/_ignition/execute-solution",
];

const NEAR_MISSES = [
  "/", "/environment", "/env", "/envelope", "/github", "/.github/workflows/ci.yml", "/gitlab", "/git",
  "/digital", "/wp-content-guide", "/wpadmin-docs", "/blog/xmlrpc-explained", "/php-guide", "/admin/pma-report",
  "/pmail", "/cgi", "/vendor/autoload.php", "/aws/", "/actuator/health", "/actuator/info",
  "/server-statusboard", "/config.php", "/backup.zip", "/etc", "/etc/passwords-guide", "/robots.txt",
  "/.well-known/security.txt", "/.well-known/acme-challenge/abc", "/HNAP", "/boa",
  "/settings.php", "/database.sql.txt", "/docs/environment-variables",
];

describe("matchProbe", () => {
  it.each(PROBES)("turns away %s", (path) => {
    expect(matchProbe(path)).not.toBeNull();
  });

  it.each(NEAR_MISSES)("leaves %s alone", (path) => {
    expect(matchProbe(path)).toBeNull();
  });

  it("answers 404 for paths whose existence matters and 403 otherwise", () => {
    expect(matchProbe("/.env")?.rule.status).toBe(404);
    expect(matchProbe("/.git/config")?.rule.status).toBe(404);
    expect(matchProbe("/config.php.bak")?.rule.status).toBe(404);
    expect(matchProbe("/wp-login.php")?.rule.status).toBe(403);
    expect(matchProbe("/HNAP1")?.rule.status).toBe(403);
  });

  it("is case-insensitive", () => {
    expect(matchProbe("/.ENV")).not.toBeNull();
    expect(matchProbe("/PhpMyAdmin/")).not.toBeNull();
  });
});

describe("WordPress apps", () => {
  it.each(["/wp-login.php", "/wp-admin/", "/xmlrpc.php", "/wp-config.php"])("keep %s", (path) => {
    expect(matchProbe(path, { wordpress: true })).toBeNull();
  });

  it.each(["/.env", "/.git/config", "/wp-config.php.bak", "/phpmyadmin/"])("still turn away %s", (path) => {
    expect(matchProbe(path, { wordpress: true })).not.toBeNull();
  });
});

describe("exceptions", () => {
  it("skip paths under an exception, the way PathPrefix reads them", () => {
    expect(matchProbe("/actuator/env", { exceptions: ["/actuator"] })).toBeNull();
    expect(matchProbe("/.env", { exceptions: ["/actuator"] })).not.toBeNull();
    expect(isExcepted("/cgi-bin/x", ["/cgi-bin/"])).toBe(true);
  });

  it("refuse paths Traefik can't take", () => {
    expect(exceptionProblem("/ok/path")).toBeNull();
    expect(exceptionProblem("no-slash")).not.toBeNull();
    expect(exceptionProblem("/with`backtick")).not.toBeNull();
    expect(exceptionProblem("/with space")).not.toBeNull();
    expect(exceptionProblem("/")).not.toBeNull();
  });
});

describe("probePathRegexp", () => {
  it("compiles and agrees with matchProbe", () => {
    const re = new RegExp(probePathRegexp(PROBE_RULES).replace(/^\(\?i\)/, ""), "i");
    for (const p of PROBES) expect(re.test(p), p).toBe(true);
    for (const p of NEAR_MISSES) expect(re.test(p), p).toBe(false);
  });

  it("uses only syntax Go's RE2 accepts", () => {
    const re = probePathRegexp(PROBE_RULES);
    expect(re).not.toMatch(/\(\?[=!<]/);
    expect(re).not.toMatch(/\\[1-9]/);
    expect(re).not.toContain("`");
  });

  it("keeps rule ids unique", () => {
    expect(new Set(PROBE_RULES.map((r) => r.id)).size).toBe(PROBE_RULES.length);
  });
});
