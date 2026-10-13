import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { PROBE_RULES } from "@/lib/probe-guard/rules";
import {
  APP_HEADER,
  CONSOLE_SERVICE,
  GUARD_FILE,
  KEY_HEADER,
  RESPONDER_SERVICE,
  banClause,
  canaryClause,
  isValidGuardFile,
  renderGuardConfig,
  renderGuardFile,
  trapClause,
  writeGuardFile,
  type GuardState,
} from "@/lib/probe-guard/traefik-file";
import { parseRule } from "@/lib/docker/traefik-rule";

const KEY = "a".repeat(64);
const state = (over: Partial<GuardState> = {}): GuardState => ({
  key: KEY,
  apps: [{ id: "app1", hosts: ["shop.example.com", "www.shop.example.com"], exceptions: [], rules: {}, blocks: [], robotsTxt: false }],
  bannedIps: [],
  trapPaths: ["/admin-backup/", "/private/db.sql"],
  markers: [],
  ...over,
});

type Parsed = { http: { routers?: Record<string, { rule: string; priority: number; service: string; middlewares: string[]; entryPoints: string[]; tls?: object }>; middlewares: Record<string, Record<string, Record<string, unknown>>>; services?: Record<string, unknown> } };
const parse = (s: GuardState) => YAML.parse(renderGuardFile(s)) as Parsed;

describe("renderGuardConfig", () => {
  it("routes an app's probes and traps on both entrypoints to the console", () => {
    const { http } = parse(state());
    expect(Object.keys(http.routers!).sort()).toEqual([
      "vardo-guard-app1-probe-web", "vardo-guard-app1-probe-websecure",
      "vardo-guard-app1-trap-web", "vardo-guard-app1-trap-websecure",
    ]);
    const probe = http.routers!["vardo-guard-app1-probe-websecure"];
    expect(probe.service).toBe(CONSOLE_SERVICE);
    expect(probe.tls).toEqual({});
    expect(probe.entryPoints).toEqual(["websecure"]);
    expect(http.routers!["vardo-guard-app1-probe-web"].tls).toBeUndefined();
    expect(probe.rule).toContain("Host(`shop.example.com`) || Host(`www.shop.example.com`)");
    expect(probe.rule).toContain("PathRegexp(`(?i)");
    expect(probe.middlewares).toEqual(["vardo-guard-app1-tag", "vardo-guard-to-probe"]);
  });

  it("tags requests with the key and app, overwriting what a client sent", () => {
    const { http } = parse(state());
    expect(http.middlewares["vardo-guard-app1-tag"].headers.customRequestHeaders).toEqual({ [KEY_HEADER]: KEY, [APP_HEADER]: "app1" });
    expect(http.middlewares["vardo-guard-tag"].headers.customRequestHeaders).toEqual({ [KEY_HEADER]: KEY, [APP_HEADER]: "" });
    expect(http.middlewares["vardo-guard-to-probe"]).toEqual({ replacePath: { path: "/probe-guard/probe" } });
  });

  it("leaves the opt-in WordPress rules out until an app turns them on", () => {
    expect(parse(state()).http.routers!["vardo-guard-app1-probe-web"].rule).not.toContain("wp-admin");
    const on = parse(state({ apps: [{ id: "wp", hosts: ["blog.example.com"], exceptions: [], rules: { "wp-admin": true }, blocks: [], robotsTxt: false }] }));
    expect(on.http.routers!["vardo-guard-wp-probe-web"].rule).toContain("wp-admin");
  });

  it("renders no probe router when every rule is off and there are no blocks", () => {
    const off = Object.fromEntries(PROBE_RULES.map((r) => [r.id, false]));
    const { http } = parse(state({ apps: [{ id: "a", hosts: ["a.example.com"], exceptions: [], rules: off, blocks: [], robotsTxt: false }] }));
    expect(Object.keys(http.routers!).filter((n) => n.includes("-a-probe") || n.includes("-a-block"))).toEqual([]);
    expect(Object.keys(http.routers!).some((n) => n.includes("-a-trap"))).toBe(true);
  });

  it("renders blocks in their own router, so exceptions never lift them", () => {
    const off = Object.fromEntries(PROBE_RULES.map((r) => [r.id, false]));
    const app = { id: "a", hosts: ["a.example.com"], exceptions: ["/phpmyadmin"], rules: off, blocks: [{ kind: "prefix" as const, value: "/phpmyadmin/setup" }], robotsTxt: false };
    const { http } = parse(state({ apps: [app] }));
    const rule = http.routers!["vardo-guard-a-block-web"].rule;
    expect(rule).toContain("PathRegexp(`(?i)(?:^/phpmyadmin/setup)`)");
    expect(rule).not.toContain("!PathPrefix");
    expect(http.routers!["vardo-guard-a-probe-web"]).toBeUndefined();
  });

  it("adds exceptions to probe and trap rules", () => {
    const { http } = parse(state({ apps: [{ id: "a", hosts: ["a.example.com"], exceptions: ["/actuator"], rules: {}, blocks: [], robotsTxt: false }] }));
    expect(http.routers!["vardo-guard-a-probe-web"].rule).toMatch(/&& !PathPrefix\(`\/actuator`\)$/);
    expect(http.routers!["vardo-guard-a-trap-web"].rule).toMatch(/&& !PathPrefix\(`\/actuator`\)$/);
  });

  it("never sends an allowlisted client to the banned router, skip-guard or not", () => {
    const { http } = parse(state({
      bannedIps: ["203.0.113.9"],
      bannedRanges: ["198.51.100.0/24"],
      allowedClients: ["198.51.100.7"],
      forwardingPeers: ["173.245.48.0/20"],
    }));
    const rule = http.routers!["vardo-guard-banned-websecure"].rule;
    expect(rule).toMatch(/&& !\(ClientIP\(`198\.51\.100\.7`\)/);
    expect(rule).toContain("198\\.51\\.100\\.7");
    expect(() => parseRule(rule)).not.toThrow();
    expect(http.routers!["vardo-guard-app1-probe-web"].rule).not.toContain("198.51.100.7");
  });

  it("puts bans and canaries above traps, probes and robots", () => {
    const { http } = parse(state({
      bannedIps: ["203.0.113.9"],
      markers: ["abcdefghjk23"],
      apps: [{ id: "app1", hosts: ["a.example.com"], exceptions: [], rules: {}, blocks: [], robotsTxt: true }],
    }));
    const p = (n: string) => http.routers![`vardo-guard-${n}-web`].priority;
    expect(p("banned")).toBeGreaterThan(p("canary"));
    expect(p("canary")).toBeGreaterThan(p("app1-trap"));
    expect(p("app1-trap")).toBeGreaterThan(p("app1-probe"));
    expect(p("app1-probe")).toBeGreaterThan(p("app1-robots"));
  });

  it("renders a file with only middlewares when no app has a domain", () => {
    const { http } = parse(state({ apps: [{ id: "x", hosts: [], exceptions: [], rules: {}, blocks: [], robotsTxt: false }], bannedIps: ["203.0.113.9"] }));
    expect(http.routers).toBeUndefined();
  });

  it("skips hosts that aren't hostnames", () => {
    const { http } = parse(state({ apps: [{ id: "a", hosts: ["ok.example.com", "bad`) || Host(`x"], exceptions: [], rules: {}, blocks: [], robotsTxt: false }] }));
    expect(http.routers!["vardo-guard-a-probe-web"].rule).not.toContain("bad");
  });

  it("matches wildcard domains by regexp", () => {
    const { http } = parse(state({ apps: [{ id: "a", hosts: ["*.apps.example.com"], exceptions: [], rules: {}, blocks: [], robotsTxt: false }] }));
    expect(http.routers!["vardo-guard-a-probe-web"].rule).toContain("HostRegexp(`^[^.]+\\.apps\\.example\\.com$`)");
  });

  it("points at a responder URL when one is set", () => {
    const { http } = parse(state({ responderUrl: "http://host.docker.internal:3000" }));
    expect(http.services).toEqual({ [RESPONDER_SERVICE]: { loadBalancer: { servers: [{ url: "http://host.docker.internal:3000" }] } } });
    expect(http.routers!["vardo-guard-app1-probe-web"].service).toBe(RESPONDER_SERVICE);
  });

  it("guards the console's host for traps and probes but never bans there", () => {
    const { http } = parse(state({
      bannedIps: ["203.0.113.9"],
      apps: [
        { id: "app1", hosts: ["a.example.com"], exceptions: [], rules: {}, blocks: [], robotsTxt: false },
        { id: "vardo-console", hosts: ["console.example.com"], exceptions: [], rules: {}, blocks: [], robotsTxt: false, console: true },
      ],
    }));
    expect(http.routers!["vardo-guard-banned-web"].rule).not.toContain("console.example.com");
    expect(http.routers!["vardo-guard-vardo-console-trap-web"].middlewares[0]).toBe("vardo-guard-tag");
    expect(http.routers!["vardo-guard-vardo-console-probe-web"].rule).toContain("console.example.com");
    expect(http.middlewares["vardo-guard-vardo-console-tag"]).toBeUndefined();
  });

  it("refuses a malformed key", () => {
    expect(() => renderGuardConfig(state({ key: "short" }))).toThrow();
  });

  it("parses every rule it writes", () => {
    const { http } = parse(state({ bannedIps: ["203.0.113.9", "2001:db8::1"], markers: ["abcdefghjk23"] }));
    for (const r of Object.values(http.routers!)) expect(() => parseRule(r.rule)).not.toThrow();
  });
});

describe("banClause", () => {
  it("matches the direct peer, any forwarded hop and CF-Connecting-IP", () => {
    const clause = banClause(["203.0.113.9", "bogus", "2001:db8::1"])!;
    expect(clause).toContain("ClientIP(`203.0.113.9`)");
    expect(clause).toContain("ClientIP(`2001:db8::1`)");
    expect(clause).not.toContain("bogus");
    const xff = /HeaderRegexp\(`X-Forwarded-For`, `([^`]+)`\)/.exec(clause)![1];
    const re = new RegExp(xff);
    expect(re.test("203.0.113.9")).toBe(true);
    expect(re.test("198.51.100.1, 203.0.113.9")).toBe(true);
    expect(re.test("203.0.113.90")).toBe(false);
    expect(re.test("1203.0.113.9")).toBe(false);
    const cf = new RegExp(/HeaderRegexp\(`Cf-Connecting-Ip`, `([^`]+)`\)/.exec(clause)![1]);
    expect(cf.test("203.0.113.9")).toBe(true);
    expect(cf.test("203.0.113.99")).toBe(false);
  });

  it("is null with nothing to ban", () => {
    expect(banClause([])).toBeNull();
    expect(banClause(["nope"])).toBeNull();
  });
});

describe("canaryClause and trapClause", () => {
  it("checks credential headers and query keys", () => {
    const clause = canaryClause(["abcdefghjk23"])!;
    expect(clause).toContain("HeaderRegexp(`Authorization`");
    expect(clause).toContain("QueryRegexp(`api_key`");
  });

  it("uses PathPrefix for directories and Path for files", () => {
    expect(trapClause(["/admin-backup/", "/private/db.sql"])).toBe("(PathPrefix(`/admin-backup/`) || Path(`/private/db.sql`))");
    expect(trapClause([])).toBeNull();
  });
});

describe("isValidGuardFile", () => {
  it("accepts what the renderer writes", () => {
    expect(isValidGuardFile(renderGuardFile(state({ bannedIps: ["203.0.113.9"], markers: ["abcdefghjk23"] })))).toBe(true);
    expect(isValidGuardFile(renderGuardFile(state({ apps: [] })))).toBe(true);
  });

  it("refuses foreign routers, services and middlewares", () => {
    const base = YAML.parse(renderGuardFile(state())) as Parsed;
    const foreignRouter = structuredClone(base);
    foreignRouter.http.routers!["other"] = { ...foreignRouter.http.routers!["vardo-guard-app1-probe-web"] };
    expect(isValidGuardFile(YAML.stringify(foreignRouter))).toBe(false);

    const foreignService = structuredClone(base);
    foreignService.http.routers!["vardo-guard-app1-probe-web"].service = "app@docker";
    expect(isValidGuardFile(YAML.stringify(foreignService))).toBe(false);

    const badMiddleware = structuredClone(base);
    badMiddleware.http.middlewares["vardo-guard-to-probe"] = { replacePath: { path: "/api/v1/admin" } };
    expect(isValidGuardFile(YAML.stringify(badMiddleware))).toBe(false);

    const badRule = structuredClone(base);
    badRule.http.routers!["vardo-guard-app1-probe-web"].rule = "Host(`x`) &&";
    expect(isValidGuardFile(YAML.stringify(badRule))).toBe(false);

    expect(isValidGuardFile("tcp: {}\n")).toBe(false);
    expect(isValidGuardFile(": not yaml :\n  - [")).toBe(false);
  });
});

describe("writeGuardFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes, then reports unchanged, leaving no temp file", async () => {
    expect(await writeGuardFile(state(), dir)).toBe("written");
    expect(await writeGuardFile(state(), dir)).toBe("unchanged");
    expect(readdirSync(dir)).toEqual([GUARD_FILE]);
    expect(readFileSync(join(dir, GUARD_FILE), "utf-8")).toMatch(/^# Written by Vardo/);
  });

  it("replaces a stale file", async () => {
    writeFileSync(join(dir, GUARD_FILE), "old");
    expect(await writeGuardFile(state({ bannedIps: ["203.0.113.9"] }), dir)).toBe("written");
    expect(readFileSync(join(dir, GUARD_FILE), "utf-8")).toContain("203.0.113.9");
  });

  it("skips where there's no Traefik volume", async () => {
    expect(await writeGuardFile(state(), "/proc/definitely/not/here")).toBe("skipped");
  });
});
