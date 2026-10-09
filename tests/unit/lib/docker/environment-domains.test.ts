import { describe, it, expect } from "vitest";
import { environmentDomains, type DeployDomain } from "@/lib/docker/environment-domains";

const row = (over: Partial<DeployDomain>): DeployDomain => ({
  id: "d1",
  appId: "app",
  domain: "app.example.com",
  pathPrefix: null,
  stripPathPrefix: false,
  serviceName: "web",
  port: 3000,
  middlewares: null,
  certResolver: "le-dns",
  isPrimary: true,
  sslEnabled: true,
  redirectTo: null,
  redirectCode: 301,
  verificationToken: null,
  verifiedAt: null,
  createdAt: new Date(0),
  ...over,
});

describe("environmentDomains", () => {
  const env = { id: "env1", domain: "pr-12.app.example.com" };

  it("keeps the parent domain's cloudflare-only middleware (#902)", () => {
    const [preview] = environmentDomains([row({ middlewares: "cloudflare-only@file" })], env, "app");
    expect(preview.domain).toBe("pr-12.app.example.com");
    expect(preview.middlewares).toBe("cloudflare-only@file");
  });

  it("takes the middlewares of the domain it routes like", () => {
    const domains = [
      row({ id: "r", domain: "old.example.com", isPrimary: false, redirectTo: "https://app.example.com" }),
      row({ id: "p", middlewares: "cloudflare-only@file,auth@docker" }),
    ];
    expect(environmentDomains(domains, env, "app")[0].middlewares).toBe("cloudflare-only@file,auth@docker");
  });

  it("routes without middlewares when the parent has none", () => {
    expect(environmentDomains([row({})], env, "app")[0].middlewares).toBeNull();
    expect(environmentDomains([], env, "app")[0].middlewares).toBeNull();
  });
});
