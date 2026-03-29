import { describe, it, expect } from "vitest";
import { buildComposePreview } from "@/lib/docker/compose";

// ---------------------------------------------------------------------------
// debug endpoint — admin gate
// ---------------------------------------------------------------------------
// Mirrors the role check in:
//   app/api/v1/organizations/[orgId]/apps/[appId]/debug/route.ts

import { isAdmin } from "@/lib/auth/permissions";

describe("debug route admin gate", () => {
  it("allows owner", () => {
    expect(isAdmin("owner")).toBe(true);
  });

  it("allows admin", () => {
    expect(isAdmin("admin")).toBe(true);
  });

  it("blocks member", () => {
    expect(isAdmin("member")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildComposePreview
// ---------------------------------------------------------------------------

const NETWORK = "vardo-network";

const baseApp = {
  name: "myapp",
  deployType: "image" as const,
  imageName: "nginx:latest",
  composeContent: null,
  containerPort: 80,
  cpuLimit: null,
  memoryLimit: null,
  gpuEnabled: false,
  exposedPorts: null,
  domains: [] as {
    id: string;
    domain: string;
    port: number | null;
    sslEnabled: boolean | null;
    certResolver: string | null;
    redirectTo: string | null;
    redirectCode: number | null;
  }[],
};

describe("buildComposePreview — image app with no compose content", () => {
  it("generates compose from imageName", () => {
    const result = buildComposePreview(baseApp, [], NETWORK);
    expect(result).not.toBeNull();
    const services = Object.values(result!.services);
    expect(services.length).toBeGreaterThan(0);
    const svc = services[0];
    expect(svc.image).toBe("nginx:latest");
  });

  it("injects the vardo network", () => {
    const result = buildComposePreview(baseApp, [], NETWORK);
    expect(result).not.toBeNull();
    const svc = Object.values(result!.services)[0];
    expect(svc.networks).toContain(NETWORK);
  });

  it("includes named volumes passed in", () => {
    const result = buildComposePreview(
      baseApp,
      [{ name: "mydata", mountPath: "/data" }],
      NETWORK,
    );
    expect(result).not.toBeNull();
    const svc = Object.values(result!.services)[0];
    expect(svc.volumes?.some((v) => typeof v === "string" && v.includes("mydata"))).toBe(true);
  });
});

describe("buildComposePreview — image app with stored compose content", () => {
  const composeYaml = `
services:
  web:
    image: myrepo/myapp:latest
    ports:
      - "3000:3000"
`.trim();

  it("uses stored compose content over imageName", () => {
    const result = buildComposePreview(
      { ...baseApp, composeContent: composeYaml },
      [],
      NETWORK,
    );
    expect(result).not.toBeNull();
    expect(result!.services.web).toBeDefined();
    expect(result!.services.web.image).toBe("myrepo/myapp:latest");
  });
});

describe("buildComposePreview — non-image app with stored compose", () => {
  it("parses stored compose content for git apps with inline compose", () => {
    const composeYaml = `
services:
  api:
    image: node:20
`.trim();
    const result = buildComposePreview(
      {
        ...baseApp,
        deployType: "git",
        imageName: null,
        composeContent: composeYaml,
      },
      [],
      NETWORK,
    );
    expect(result).not.toBeNull();
    expect(result!.services.api).toBeDefined();
  });
});

describe("buildComposePreview — git app with no stored compose", () => {
  it("returns null — compose is only generated at build time", () => {
    const result = buildComposePreview(
      {
        ...baseApp,
        deployType: "git",
        imageName: null,
        composeContent: null,
      },
      [],
      NETWORK,
    );
    expect(result).toBeNull();
  });
});

describe("buildComposePreview — invalid compose content", () => {
  it("returns null when stored compose content cannot be parsed", () => {
    const result = buildComposePreview(
      { ...baseApp, composeContent: "{ not: [valid yaml: here" },
      [],
      NETWORK,
    );
    expect(result).toBeNull();
  });
});

describe("buildComposePreview — resource limits", () => {
  it("injects resource limits into the generated compose", () => {
    const result = buildComposePreview(
      { ...baseApp, cpuLimit: 2, memoryLimit: 512 },
      [],
      NETWORK,
    );
    expect(result).not.toBeNull();
    const svc = Object.values(result!.services)[0];
    expect(svc.deploy?.resources?.limits?.cpus).toBe("2");
    expect(svc.deploy?.resources?.limits?.memory).toBe("512M");
  });
});
