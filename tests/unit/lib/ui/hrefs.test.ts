import { describe, it, expect } from "vitest";
import { appHref, deployHref, imageUrl, projectHref, securityHref, siteUrl } from "@/lib/ui/hrefs";

describe("entity hrefs", () => {
  it("builds app, tab and deploy paths", () => {
    expect(appHref("web")).toBe("/apps/web");
    expect(appHref("web", "logs")).toBe("/apps/web/logs");
    expect(deployHref("web", "d1")).toBe("/apps/web/deployments/d1");
  });

  it("builds project and security paths", () => {
    expect(projectHref("home")).toBe("/projects/home");
    expect(securityHref("web")).toBe("/apps/web/security");
    expect(securityHref("web", "exposed-env")).toBe("/apps/web/security#finding-exposed-env");
  });
});

describe("siteUrl", () => {
  it("adds https to a bare domain and keeps an existing scheme", () => {
    expect(siteUrl("example.com")).toBe("https://example.com");
    expect(siteUrl("http://example.com")).toBe("http://example.com");
  });
});

describe("imageUrl", () => {
  it("sends official images to their Docker Hub page", () => {
    expect(imageUrl("postgres:17")).toBe("https://hub.docker.com/_/postgres");
    expect(imageUrl("library/redis")).toBe("https://hub.docker.com/_/redis");
  });

  it("sends namespaced Hub images to the repository", () => {
    expect(imageUrl("grafana/loki:3.0.0")).toBe("https://hub.docker.com/r/grafana/loki");
  });

  it("uses the registry host when there is one", () => {
    expect(imageUrl("ghcr.io/acme/api:latest")).toBe("https://ghcr.io/acme/api");
    expect(imageUrl("quay.io/org/tool@sha256:abc")).toBe("https://quay.io/org/tool");
  });

  it("gives up on local registries", () => {
    expect(imageUrl("localhost:5000/app")).toBeNull();
    expect(imageUrl("registry.local:5000/app")).toBeNull();
  });
});
