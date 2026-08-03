import { describe, expect, it } from "vitest";

import {
  indexImageSizes,
  selectCandidates,
  type PlannableApp,
} from "@/lib/docker/image-reclaim/plan";

const NOW = new Date("2026-08-02T00:00:00Z");
const LONG_AGO = new Date("2026-01-01T00:00:00Z");
const YESTERDAY = new Date("2026-08-01T00:00:00Z");

function app(overrides: Partial<PlannableApp> = {}): PlannableApp {
  return {
    id: "app_1",
    name: "jellyfin",
    displayName: "Jellyfin",
    status: "missing",
    deployType: "image",
    imageName: "jellyfin/jellyfin:10.9.11",
    composeContent: null,
    composeService: null,
    isSystemManaged: false,
    imageReclaimPolicy: "auto",
    imageReclaimIdleDays: null,
    lastRunningAt: LONG_AGO,
    ...overrides,
  };
}

const SIZES = indexImageSizes([
  { repoTags: ["jellyfin/jellyfin:10.9.11"], size: 1_000 },
  { repoTags: ["jellyfin/jellyfin:latest"], size: 2_000 },
  { repoTags: ["postgres:16"], size: 4_000 },
  { repoTags: ["nginx:1.27"], size: 8_000 },
  { repoTags: ["acme/built:latest"], size: 16_000 },
]);

function plan(rows: PlannableApp[], defaultIdleDays = 30) {
  return selectCandidates(rows, SIZES, { defaultIdleDays, now: NOW });
}

function reasonFor(result: ReturnType<typeof plan>, appId = "app_1") {
  return result.skipped.find((s) => s.appId === appId)?.reason;
}

describe("selectCandidates — the happy path", () => {
  it("selects an idle app on a pinned tag", () => {
    const result = plan([app()]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].appName).toBe("jellyfin");
    expect(result.candidates[0].images.map((i) => i.image)).toEqual(["jellyfin/jellyfin:10.9.11"]);
    expect(result.estimatedBytes).toBe(1_000);
  });

  it("reports idle age and the threshold it was measured against", () => {
    const result = plan([app({ imageReclaimIdleDays: 7 })]);
    expect(result.candidates[0].thresholdDays).toBe(7);
    expect(result.candidates[0].idleDays).toBeGreaterThan(200);
  });
});

describe("selectCandidates — excluded classes are never selected", () => {
  const cases: [string, Partial<PlannableApp>, string][] = [
    ["Vardo itself", { name: "vardo" }, "self"],
    ["system-managed apps", { isSystemManaged: true }, "system-managed"],
    ["apps the user pinned", { imageReclaimPolicy: "never" }, "pinned-by-user"],
    ["running apps", { status: "active" }, "running"],
    ["deploying apps", { status: "deploying" }, "running"],
    ["apps in error", { status: "error" }, "error"],
    ["apps never observed running", { lastRunningAt: null }, "never-run"],
    ["apps idle for less than the threshold", { lastRunningAt: YESTERDAY }, "not-idle"],
  ];

  for (const [label, overrides, reason] of cases) {
    it(`excludes ${label}`, () => {
      const result = plan([app(overrides)]);
      expect(result.candidates).toHaveLength(0);
      expect(reasonFor(result)).toBe(reason);
    });
  }

  it("excludes a compose that builds locally — a reclaimed image cannot be pulled back", () => {
    const result = plan([
      app({
        deployType: "compose",
        imageName: null,
        composeContent: ["services:", "  app:", "    build:", "      context: ."].join("\n"),
      }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("builds-locally");
  });

  it("excludes a compose app whose compose we cannot read", () => {
    // Git-source apps keep their compose on disk. Without it we cannot prove
    // there is no `build:`, so we refuse rather than guess.
    const result = plan([app({ deployType: "compose", imageName: null, composeContent: null })]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("compose-unavailable");
  });

  it("excludes an unpinned stateful image even when the app opted in", () => {
    const result = plan([
      app({
        deployType: "compose",
        imageName: null,
        imageReclaimPolicy: "always",
        composeContent: ["services:", "  db:", "    image: postgres:16"].join("\n"),
      }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("stateful-floating");
  });

  it("excludes a floating tag under the default policy", () => {
    const result = plan([app({ imageName: "jellyfin/jellyfin:latest" })]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("floating-tag");
  });

  it("includes a floating tag once the app opts in", () => {
    const result = plan([
      app({ imageName: "jellyfin/jellyfin:latest", imageReclaimPolicy: "always" }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].images[0].safety).toBe("floating");
  });

  it("disqualifies the whole app when one image in the stack is unsafe", () => {
    const result = plan([
      app({
        deployType: "compose",
        imageName: null,
        composeContent: [
          "services:",
          "  web:",
          "    image: nginx:1.27",
          "  db:",
          "    image: postgres:16",
        ].join("\n"),
      }),
    ]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("stateful-floating");
  });

  it("skips an app whose images are not present locally", () => {
    const result = plan([app({ imageName: "ghcr.io/absent/thing:1.2.3" })]);
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result)).toBe("no-images");
  });
});

describe("selectCandidates — volumes are never in scope", () => {
  it("plans only images, never a volume, for an app that declares volumes", () => {
    const compose = [
      "services:",
      "  web:",
      "    image: nginx:1.27",
      "    volumes:",
      "      - web-data:/var/lib/data",
      "      - /mnt/media:/media",
      "volumes:",
      "  web-data:",
    ].join("\n");

    const result = plan([app({ deployType: "compose", imageName: null, composeContent: compose })]);

    expect(result.candidates).toHaveLength(1);
    const planned = result.candidates[0].images.map((i) => i.image);
    expect(planned).toEqual(["nginx:1.27"]);
    // Nothing volume-shaped may appear anywhere in the plan.
    expect(JSON.stringify(result)).not.toContain("web-data");
    expect(JSON.stringify(result)).not.toContain("/mnt/media");
  });
});

describe("selectCandidates — determinism", () => {
  it("returns the same plan for the same input", () => {
    const rows = [app(), app({ id: "app_2", name: "other", status: "active" })];
    expect(plan(rows)).toEqual(plan(rows));
  });

  it("accounts for every app as either a candidate or a skip", () => {
    const rows = [
      app(),
      app({ id: "app_2", name: "vardo" }),
      app({ id: "app_3", name: "db", status: "active" }),
    ];
    const result = plan(rows);
    expect(result.candidates.length + result.skipped.length).toBe(rows.length);
  });
});

describe("indexImageSizes", () => {
  it("indexes by normalized ref so short Docker Hub names match", () => {
    const sizes = indexImageSizes([{ repoTags: ["nginx:1.27"], size: 42 }]);
    expect(sizes.get("docker.io/library/nginx:1.27")).toBe(42);
  });
});
