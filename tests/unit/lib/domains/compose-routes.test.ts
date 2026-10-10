import { describe, it, expect } from "vitest";
import {
  discoverComposeRoutes,
  discoverContainerRoutes,
  hostsFromRule,
  routesFromLabels,
  vardoRouterMatcher,
} from "@/lib/domains/compose-routes";
import { injectTraefikLabels } from "@/lib/docker/compose-inject";
import { namespaceTraefikNames } from "@/lib/docker/traefik-names";
import type { ComposeFile } from "@/lib/docker/compose-types";

const hosts = (rule: string) => {
  const out = hostsFromRule(rule);
  if ("error" in out) throw new Error(out.error);
  return out.routes.map((r) => `${r.host}${r.pathPrefix ?? ""}`);
};

const compose = (labels: Record<string, string>, service = "web"): ComposeFile => ({
  services: { [service]: { name: service, image: "nginx", labels } },
});

describe("hostsFromRule", () => {
  it("reads a single host", () => {
    expect(hosts("Host(`app.example.com`)")).toEqual(["app.example.com"]);
  });

  it("reads several hosts in one matcher and across ||", () => {
    expect(hosts("Host(`a.example.com`, `b.example.com`)")).toEqual(["a.example.com", "b.example.com"]);
    expect(hosts("Host(`a.example.com`) || Host(`b.example.com`)")).toEqual(["a.example.com", "b.example.com"]);
  });

  it("reads backticks and double quotes, and lowercases", () => {
    expect(hosts('Host("App.Example.com")')).toEqual(["app.example.com"]);
  });

  it("records a path prefix with its host", () => {
    expect(hosts("Host(`app.example.com`) && PathPrefix(`/api`)")).toEqual(["app.example.com/api"]);
    expect(hosts("PathPrefix(`/api`) && (Host(`a.example.com`) || Host(`b.example.com`))")).toEqual([
      "a.example.com/api",
      "b.example.com/api",
    ]);
  });

  it("collapses Vardo's Path || PathPrefix pair into one route", () => {
    expect(hosts("Host(`app.example.com`) && (Path(`/docs`) || PathPrefix(`/docs/`))")).toEqual(["app.example.com/docs"]);
  });

  it("treats PathPrefix(`/`) as the whole host", () => {
    expect(hosts("Host(`app.example.com`) && PathPrefix(`/`)")).toEqual(["app.example.com"]);
  });

  it("reads HostSNI and skips the wildcard", () => {
    expect(hosts("HostSNI(`db.example.com`)")).toEqual(["db.example.com"]);
    expect(hosts("HostSNI(`*`)")).toEqual([]);
  });

  it("ignores catch-alls and contradictory hosts", () => {
    expect(hosts("PathPrefix(`/`)")).toEqual([]);
    expect(hosts("Host(`a.example.com`) && Host(`b.example.com`)")).toEqual([]);
  });

  it("notes zones and regexps it can't pin to one host", () => {
    const out = hostsFromRule("HostRegexp(`^.+\\.example\\.com$`) || Host(`app.example.com`)");
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.routes.map((r) => r.host)).toEqual(["app.example.com"]);
    expect(out.unread[0]).toContain("example.com");
  });

  it("reports a rule it can't parse", () => {
    expect(hostsFromRule("Host(`app.example.com`")).toHaveProperty("error");
  });
});

describe("routesFromLabels", () => {
  it("reads TLS, cert resolver and the service port", () => {
    const { routes } = routesFromLabels("web", {
      "traefik.enable": "true",
      "traefik.http.routers.site.rule": "Host(`app.example.com`)",
      "traefik.http.routers.site.entrypoints": "websecure",
      "traefik.http.routers.site.tls.certresolver": "le",
      "traefik.http.services.site.loadbalancer.server.port": "8080",
    });
    expect(routes).toEqual([
      { service: "web", router: "site", host: "app.example.com", pathPrefix: null, tls: true, certResolver: "le", port: 8080 },
    ]);
  });

  it("matches the port to the router's own service", () => {
    const { routes } = routesFromLabels("web", {
      "traefik.http.routers.api.rule": "Host(`api.example.com`)",
      "traefik.http.routers.api.service": "api@docker",
      "traefik.http.services.api.loadbalancer.server.port": "4000",
      "traefik.http.services.ui.loadbalancer.server.port": "3000",
    });
    expect(routes[0].port).toBe(4000);
    expect(routes[0].tls).toBe(false);
  });

  it("skips an unresolved variable with a note", () => {
    const { routes, notes } = routesFromLabels("web", {
      "traefik.http.routers.site.rule": "Host(`${APP_HOST}`)",
    });
    expect(routes).toEqual([]);
    expect(notes).toEqual([{ service: "web", router: "site", note: "skipped: ${APP_HOST} isn't set" }]);
  });

  it("resolves variables from the app's env", () => {
    const { routes } = routesFromLabels(
      "web",
      { "traefik.http.routers.site.rule": "Host(`${APP_HOST:-fallback.example.com}`)" },
      { appEnv: { APP_HOST: "app.example.com" } },
    );
    expect(routes.map((r) => r.host)).toEqual(["app.example.com"]);
  });

  it("drops the app-id namespace from the router name", () => {
    const { routes } = routesFromLabels(
      "web",
      { "traefik.http.routers.abc123-site.rule": "Host(`app.example.com`)" },
      { namePrefix: "ABC123" },
    );
    expect(routes[0].router).toBe("site");
  });

  it("marks TCP routers as TLS", () => {
    const { routes } = routesFromLabels("db", { "traefik.tcp.routers.pg.rule": "HostSNI(`db.example.com`)" });
    expect(routes[0]).toMatchObject({ host: "db.example.com", tls: true, port: null });
  });
});

describe("Vardo router exclusion", () => {
  it("skips routers Vardo injected for its own domain rows", () => {
    const own = compose({
      "traefik.enable": "true",
      "traefik.http.routers.site.rule": "Host(`app.example.com`)",
      "traefik.http.routers.site.entrypoints": "websecure",
    });
    const injected = injectTraefikLabels(own, {
      projectName: "shop-Dm4x9Kq2",
      appName: "shop",
      domain: "shop.example.com",
      containerPort: 3000,
    });
    const { routes } = discoverComposeRoutes(injected, {
      isVardoRouter: vardoRouterMatcher("shop", ["Dm4x9Kq2abcdefgh"]),
    });
    expect(routes.map((r) => r.host)).toEqual(["app.example.com"]);
  });

  it("finds tenant routers after namespacing", () => {
    const ns = namespaceTraefikNames(compose({ "traefik.http.routers.site.rule": "Host(`app.example.com`)" }), "AppId1", { trusted: false });
    const { routes } = discoverComposeRoutes(ns.compose, { namePrefix: "AppId1" });
    expect(routes).toHaveLength(1);
    expect(routes[0].router).toBe("site");
  });

  it("skips the internal reach routers", () => {
    const { routes } = routesFromLabels("web", { "traefik.http.routers.vardo-reach.rule": "Host(`x.example.com`)" });
    expect(routes).toEqual([]);
  });
});

describe("discoverComposeRoutes", () => {
  it("merges the HTTP and HTTPS routers for a host", () => {
    const { routes } = discoverComposeRoutes(compose({
      "traefik.http.routers.site-http.rule": "Host(`app.example.com`)",
      "traefik.http.routers.site-http.entrypoints": "web",
      "traefik.http.routers.site.rule": "Host(`app.example.com`)",
      "traefik.http.routers.site.tls": "true",
    }));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ router: "site", tls: true });
  });

  it("reads every service", () => {
    const file: ComposeFile = {
      services: {
        web: { name: "web", image: "a", labels: { "traefik.http.routers.web.rule": "Host(`www.example.com`)" } },
        admin: { name: "admin", image: "b", labels: { "traefik.http.routers.admin.rule": "Host(`admin.example.com`)" } },
        db: { name: "db", image: "postgres" },
      },
    };
    expect(discoverComposeRoutes(file).routes.map((r) => `${r.service}:${r.host}`)).toEqual([
      "web:www.example.com",
      "admin:admin.example.com",
    ]);
  });
});

describe("discoverContainerRoutes", () => {
  it("reads slot-named routers from running containers", () => {
    const { routes } = discoverContainerRoutes(
      [
        {
          labels: {
            "com.docker.compose.service": "web",
            "traefik.http.routers.appid1-site-blue.rule": "Host(`app.example.com`)",
            "traefik.http.routers.appid1-site-blue.service": "appid1-site-blue",
            "traefik.http.services.appid1-site-blue.loadbalancer.server.port": "8080",
            "traefik.http.routers.shop-dm4x9kq2-blue.rule": "Host(`shop.example.com`)",
          },
        },
        { labels: { "com.docker.compose.service": "db" } },
      ],
      { namePrefix: "appid1", isVardoRouter: vardoRouterMatcher("shop", ["dm4x9kq2zzzz"]) },
    );
    expect(routes).toEqual([
      { service: "web", router: "site", host: "app.example.com", pathPrefix: null, tls: false, certResolver: null, port: 8080 },
    ]);
  });

  it("keeps regexp dollar signs literal in interpolated labels", () => {
    const { routes, notes } = discoverContainerRoutes([
      {
        labels: {
          "com.docker.compose.service": "web",
          "traefik.http.routers.r.rule": "HostRegexp(`^app\\.example\\.com$`)",
        },
      },
    ]);
    expect(notes).toEqual([]);
    expect(routes.map((r) => r.host)).toEqual(["app.example.com"]);
  });
});
