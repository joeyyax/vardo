import { describe, it, expect } from "vitest";
import { parseRule, regexpClaim, judgeRule, type HostClaim, type ClaimVerdict } from "@/lib/docker/traefik-rule";
import { interpolate } from "@/lib/docker/compose-hosts";

const OWNED = new Set(["app.example.com", "www.example.com"]);
const judge = (c: HostClaim): ClaimVerdict => {
  if (c.kind === "any") return "any";
  if (c.kind === "unknown") return "uncertain";
  if (c.kind === "zone") return c.zone === "example.com" ? "owned" : "unowned";
  return OWNED.has(c.host) ? "owned" : c.host === "victim.com" ? "foreign" : "unowned";
};
const verdict = (rule: string) => judgeRule(parseRule(rule), judge).verdict;

describe("parseRule", () => {
  it("reads Host, HostSNI and multiple hosts joined with ||", () => {
    expect(verdict("Host(`app.example.com`)")).toBe("owned");
    expect(verdict("HostSNI(`app.example.com`)")).toBe("owned");
    expect(verdict("Host(`app.example.com`) || Host(`www.example.com`)")).toBe("owned");
    expect(verdict("Host(`app.example.com`) || Host(`victim.com`)")).toBe("foreign");
    expect(verdict("Host(`app.example.com`)  ||  Host(`other.net`)")).toBe("unowned");
  });

  it("reads v2 multi-argument Host and double-quoted strings", () => {
    expect(verdict('Host("app.example.com", "www.example.com")')).toBe("owned");
    expect(verdict("Host(`app.example.com`, `victim.com`)")).toBe("foreign");
  });

  it("lowercases hosts and matcher names", () => {
    expect(verdict("host(`APP.Example.com`)")).toBe("owned");
  });

  it("owns an && when either side is owned", () => {
    expect(verdict("Host(`app.example.com`) && PathPrefix(`/api`)")).toBe("owned");
    expect(verdict("PathPrefix(`/api`) && (Host(`app.example.com`) || Host(`www.example.com`))")).toBe("owned");
    expect(verdict("Host(`victim.com`) && PathPrefix(`/api`)")).toBe("foreign");
  });

  it("owns the path-route rule Vardo writes", () => {
    expect(verdict("Host(`app.example.com`) && (Path(`/docs`) || PathPrefix(`/docs/`))")).toBe("owned");
    expect(verdict("Host(`victim.com`) && (Path(`/docs`) || PathPrefix(`/docs/`))")).toBe("foreign");
  });

  it("treats rules without a host matcher as claiming every host", () => {
    expect(verdict("PathPrefix(`/`)")).toBe("any");
    expect(verdict("HostSNI(`*`)")).toBe("any");
    expect(verdict("!Host(`app.example.com`)")).toBe("any");
    expect(verdict("Host(`app.example.com`) || PathPrefix(`/`)")).toBe("any");
  });

  it("refuses syntax it can't read", () => {
    expect(() => parseRule("Host(`a.com`")).toThrow();
    expect(() => parseRule("Host(`a.com`) &&")).toThrow();
    expect(() => parseRule("Host()")).toThrow();
    expect(() => parseRule("Host(`a.com`) Host(`b.com`)")).toThrow();
  });

  it("marks non-hostname Host arguments uncertain", () => {
    expect(verdict("Host(`*.example.com`)")).toBe("uncertain");
  });
});

describe("regexpClaim", () => {
  it("pins anchored regexps to a host or zone", () => {
    expect(regexpClaim("^app\\.example\\.com$")).toEqual({ kind: "host", host: "app.example.com" });
    expect(regexpClaim("^[a-z0-9-]+\\.example\\.com$")).toEqual({ kind: "zone", zone: "example.com" });
    expect(regexpClaim("(?i)^.+\\.example\\.com$")).toEqual({ kind: "zone", zone: "example.com" });
  });

  it("can't pin unanchored, label-crossing or alternating regexps", () => {
    expect(regexpClaim(".*[a-zA-Z].*").kind).toBe("unknown");
    expect(regexpClaim("^app\\.example\\.com").kind).toBe("unknown");
    expect(regexpClaim(".*example\\.com$").kind).toBe("unknown");
    expect(regexpClaim("^a\\.example\\.com$|^b\\.victim\\.com$").kind).toBe("unknown");
    expect(regexpClaim("^.+\\.com$").kind).toBe("unknown");
    expect(regexpClaim("app.example.com$").kind).toBe("unknown");
  });

  it("feeds HostRegexp and HostSNIRegexp verdicts", () => {
    expect(verdict("HostRegexp(`^[a-z]+\\.example\\.com$`)")).toBe("owned");
    expect(verdict("HostSNIRegexp(`^[a-z]+\\.other\\.net$`)")).toBe("unowned");
    expect(verdict("HostRegexp(`.+`)")).toBe("uncertain");
  });
});

describe("interpolate", () => {
  it("follows Compose precedence and defaults", () => {
    expect(interpolate("Host(`${H}`)", { H: "app.example.com" }, {})).toEqual({ value: "Host(`app.example.com`)" });
    expect(interpolate("Host(`${H}`)", { H: "app.example.com" }, { H: "console.test" })).toEqual({ value: "Host(`console.test`)" });
    expect(interpolate("Host(`${H:-fallback.test}`)", {}, {})).toEqual({ value: "Host(`fallback.test`)" });
    expect(interpolate("Host(`$H`)", { H: "a.test" }, {})).toEqual({ value: "Host(`a.test`)" });
    expect(interpolate("Host(`$$H`)", {}, {})).toEqual({ value: "Host(`$H`)" });
  });

  it("fails on unset variables and unresolved templates", () => {
    expect(interpolate("Host(`${H}`)", {}, {})).toHaveProperty("error");
    expect(interpolate("Host(`${H}`)", { H: "${project.domain}" }, {})).toHaveProperty("error");
  });
});
