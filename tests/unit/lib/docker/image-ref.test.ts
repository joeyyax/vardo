import { describe, expect, it } from "vitest";
import {
  isMutableShortForm,
  parseImageRef,
  refCacheKey,
  withTag,
} from "@/lib/docker/image-updates/image-ref";
import { appImages, extractComposeImages } from "@/lib/docker/image-updates/compose-images";
import { setImageRefTag, setServiceImageTag } from "@/lib/docker/image-updates/apply";

describe("parseImageRef", () => {
  const cases: Array<[string, { registry: string; repository: string; tag: string }]> = [
    ["nginx", { registry: "docker.io", repository: "library/nginx", tag: "latest" }],
    ["nginx:1.27", { registry: "docker.io", repository: "library/nginx", tag: "1.27" }],
    ["gitea/gitea:1.26.2", { registry: "docker.io", repository: "gitea/gitea", tag: "1.26.2" }],
    [
      "lscr.io/linuxserver/plex:1.41.0",
      { registry: "lscr.io", repository: "linuxserver/plex", tag: "1.41.0" },
    ],
    [
      "ghcr.io/owner/app:v2.24.0",
      { registry: "ghcr.io", repository: "owner/app", tag: "v2.24.0" },
    ],
    [
      "localhost:5000/app:1.0.0",
      { registry: "localhost:5000", repository: "app", tag: "1.0.0" },
    ],
    [
      "registry.example.com:8443/team/app:1.0",
      { registry: "registry.example.com:8443", repository: "team/app", tag: "1.0" },
    ],
    [
      "index.docker.io/library/redis:7",
      { registry: "docker.io", repository: "library/redis", tag: "7" },
    ],
  ];

  it.each(cases)("parses %s", (input, expected) => {
    expect(parseImageRef(input)).toMatchObject(expected);
  });

  it("keeps the digest and the tag when both are present", () => {
    const ref = parseImageRef("nginx:1.27@sha256:abc");
    expect(ref).toMatchObject({ tag: "1.27", digest: "sha256:abc" });
  });

  it("refuses refs that interpolate a variable", () => {
    expect(parseImageRef("gitea/gitea:${GITEA_VERSION}")).toBeNull();
    expect(parseImageRef("")).toBeNull();
  });
});

describe("withTag", () => {
  it.each([
    ["gitea/gitea:1.26.2", "1.27.0", "gitea/gitea:1.27.0"],
    ["nginx:1.27", "1.28", "nginx:1.28"],
    ["lscr.io/linuxserver/plex:1.41.0", "1.42.0", "lscr.io/linuxserver/plex:1.42.0"],
    ["ghcr.io/owner/app:v1.0.0", "v1.1.0", "ghcr.io/owner/app:v1.1.0"],
  ])("rewrites %s to %s", (input, tag, expected) => {
    expect(withTag(parseImageRef(input)!, tag)).toBe(expected);
  });

  it("drops a digest pin so the new tag actually resolves", () => {
    expect(withTag(parseImageRef("nginx:1.27@sha256:abc")!, "1.28")).toBe("nginx:1.28");
  });
});

describe("refCacheKey", () => {
  it("collapses equivalent refs onto one key", () => {
    expect(refCacheKey(parseImageRef("nginx:1.27")!)).toBe(
      refCacheKey(parseImageRef("index.docker.io/library/nginx:1.27")!),
    );
  });
});

describe("isMutableShortForm", () => {
  it("flags LinuxServer tags without an ls build counter", () => {
    const ref = parseImageRef("lscr.io/linuxserver/plex:4.0.17")!;
    expect(isMutableShortForm(ref, "4.0.17")).toBe(true);
    expect(isMutableShortForm(ref, "4.0.17.2952-ls314")).toBe(false);
  });

  it("leaves other publishers alone", () => {
    const ref = parseImageRef("gitea/gitea:1.26.2")!;
    expect(isMutableShortForm(ref, "1.26.2")).toBe(false);
  });
});

const COMPOSE = `# Managed by hand
services:
  # the app itself
  gitea:
    image: gitea/gitea:1.26.2 # pinned deliberately
    restart: unless-stopped
  db:
    image: postgres:16.4-alpine
  builder:
    build: ./src
  templated:
    image: ghcr.io/owner/app:\${VERSION}
`;

describe("extractComposeImages", () => {
  it("returns pinnable services only", () => {
    const images = extractComposeImages(COMPOSE);
    expect(images.map((i) => i.service)).toEqual(["gitea", "db"]);
  });

  it("returns nothing for unparseable YAML", () => {
    expect(extractComposeImages("services: [")).toEqual([]);
  });
});

describe("appImages", () => {
  const base = { deployType: "compose", imageName: null, composeContent: COMPOSE };

  it("returns every service for a parent app", () => {
    expect(appImages({ ...base, composeService: null })).toHaveLength(2);
  });

  it("narrows to one service for a child app", () => {
    const images = appImages({ ...base, composeService: "db" });
    expect(images).toHaveLength(1);
    expect(images[0].image).toBe("postgres:16.4-alpine");
  });

  it("uses imageName for single-image apps", () => {
    const images = appImages({
      deployType: "image",
      imageName: "redis:7.4",
      composeContent: null,
      composeService: null,
    });
    expect(images[0]).toMatchObject({ service: null, image: "redis:7.4" });
  });
});

describe("setServiceImageTag", () => {
  it("rewrites one service and leaves the rest byte-identical", () => {
    const result = setServiceImageTag(COMPOSE, "gitea", "1.27.0");
    expect(result).not.toBeNull();
    expect(result!.previousImage).toBe("gitea/gitea:1.26.2");
    expect(result!.newImage).toBe("gitea/gitea:1.27.0");
    expect(result!.content).toContain("image: gitea/gitea:1.27.0");
    expect(result!.content).toContain("image: postgres:16.4-alpine");
  });

  it("preserves comments and unrelated formatting", () => {
    const result = setServiceImageTag(COMPOSE, "gitea", "1.27.0")!;
    expect(result.content).toContain("# Managed by hand");
    expect(result.content).toContain("# the app itself");
    expect(result.content).toContain("# pinned deliberately");
    expect(result.content).toContain("build: ./src");
  });

  it("returns null when nothing would change", () => {
    expect(setServiceImageTag(COMPOSE, "gitea", "1.26.2")).toBeNull();
  });

  it("returns null for a service that has no image", () => {
    expect(setServiceImageTag(COMPOSE, "builder", "1.0.0")).toBeNull();
    expect(setServiceImageTag(COMPOSE, "nope", "1.0.0")).toBeNull();
  });

  it("refuses a templated image rather than baking the variable in", () => {
    expect(setServiceImageTag(COMPOSE, "templated", "1.0.0")).toBeNull();
  });
});

describe("setImageRefTag", () => {
  it("swaps the tag on a bare ref", () => {
    expect(setImageRefTag("redis:7.4", "7.6")).toEqual({
      previousImage: "redis:7.4",
      newImage: "redis:7.6",
    });
  });

  it("returns null when the tag already matches", () => {
    expect(setImageRefTag("redis:7.4", "7.4")).toBeNull();
  });
});
