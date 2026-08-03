import { describe, expect, it } from "vitest";

import {
  selectSlotCandidates,
  type SlotPlanInput,
} from "@/lib/docker/image-reclaim/slot-plan";
import type { SlotApp, SlotEnvironment } from "@/lib/docker/image-reclaim/slot-policy";
import type { ImageInfo } from "@/lib/docker/client";

const NOW = new Date("2026-08-03T00:00:00Z");

/** A locally built compose image, the way Docker reports one. */
function image(project: string, service: string, overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    id: `sha256:${project}-${service}`,
    repoTags: [`${project}-${service}:latest`],
    size: 1_000,
    labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.service": service,
    },
    ...overrides,
  };
}

function env(overrides: Partial<SlotEnvironment> = {}): SlotEnvironment {
  return { appName: "agents", envName: "production", currentSlot: "green", ...overrides };
}

function plan(input: Partial<SlotPlanInput> = {}) {
  return selectSlotCandidates({
    images: [],
    environments: [env()],
    apps: [],
    projectsWithContainers: new Set<string>(),
    now: NOW,
    ...input,
  });
}

function reasonFor(result: ReturnType<typeof plan>, tag: string) {
  return result.skipped.find((s) => s.image === tag)?.reason;
}

function takenTags(result: ReturnType<typeof plan>) {
  return result.candidates.flatMap((c) => c.images.map((i) => i.image));
}

describe("selectSlotCandidates — the happy path", () => {
  it("takes the standby generation once its slot has no containers left", () => {
    const result = plan({ images: [image("agents-production-blue", "bot")] });
    expect(takenTags(result)).toEqual(["agents-production-blue-bot:latest"]);
    expect(result.candidates[0].generation).toEqual({
      kind: "slot",
      appName: "agents",
      envName: "production",
      slot: "blue",
    });
    expect(result.estimatedBytes).toBe(1_000);
  });

  it("groups a generation's services under one compose project", () => {
    const result = plan({
      images: [
        image("agents-production-blue", "worker", { size: 500 }),
        image("agents-production-blue", "bot", { size: 300 }),
      ],
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].project).toBe("agents-production-blue");
    expect(result.candidates[0].estimatedBytes).toBe(800);
  });

  it("takes a pre-slot build, which no symlink can name", () => {
    const result = plan({ images: [image("agents", "bot"), image("green", "reeve")] });
    expect(takenTags(result).sort()).toEqual(["agents-bot:latest", "green-reeve:latest"]);
    expect(result.candidates.every((c) => c.generation.kind === "legacy")).toBe(true);
  });

  it("takes the blue standby when green is live, and green when blue is", () => {
    const images = [image("agents-production-blue", "bot"), image("agents-production-green", "bot")];
    expect(takenTags(plan({ images }))).toEqual(["agents-production-blue-bot:latest"]);
    expect(
      takenTags(plan({ images, environments: [env({ currentSlot: "blue" })] })),
    ).toEqual(["agents-production-green-bot:latest"]);
  });
});

describe("selectSlotCandidates — rollback must survive the sweep", () => {
  it("refuses the image the live slot needs", () => {
    const result = plan({ images: [image("agents-production-green", "bot")] });
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result, "agents-production-green-bot:latest")).toBe("live-slot");
  });

  it("refuses the live slot even when it is fully stopped and holds no containers", () => {
    // An app taken all the way down loses its containers on both slots. Only the
    // symlink still says which generation a restart would come back on.
    const result = plan({
      images: [image("agents-production-green", "bot")],
      projectsWithContainers: new Set<string>(),
    });
    expect(reasonFor(result, "agents-production-green-bot:latest")).toBe("live-slot");
  });

  it("refuses an image a stopped standby container needs", () => {
    // `stopStandbySlot` uses `stop`, not `down` — these containers are kept on
    // purpose, and instant rollback restarts them with `--pull never`.
    const result = plan({
      images: [image("agents-production-blue", "bot")],
      projectsWithContainers: new Set(["agents-production-blue"]),
    });
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result, "agents-production-blue-bot:latest")).toBe("slot-in-use");
  });

  it("refuses the whole standby generation when only a sibling service has containers", () => {
    // Rollback brings up the slot, not one image. A generation is all or nothing.
    const result = plan({
      images: [image("agents-production-blue", "bot"), image("agents-production-blue", "worker")],
      projectsWithContainers: new Set(["agents-production-blue"]),
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(["slot-in-use", "slot-in-use"]);
  });

  it("refuses both slots when 'current' cannot be read", () => {
    const result = plan({
      images: [image("agents-production-blue", "bot"), image("agents-production-green", "bot")],
      environments: [env({ currentSlot: null })],
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "current-unreadable",
      "current-unreadable",
    ]);
  });

  it("refuses a legacy pre-slot project that still has containers", () => {
    const result = plan({
      images: [image("agents", "bot")],
      projectsWithContainers: new Set(["agents"]),
    });
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result, "agents-bot:latest")).toBe("slot-in-use");
  });
});

describe("selectSlotCandidates — what the sweep is not allowed to reach", () => {
  it("refuses Vardo's own slots", () => {
    const result = plan({
      images: [image("vardo-production-blue", "frontend"), image("vardo", "frontend")],
      environments: [env({ appName: "vardo", envName: "production", currentSlot: "green" })],
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(["self", "self"]);
  });

  it("refuses a system-managed app", () => {
    const apps: SlotApp[] = [{ name: "agents", isSystemManaged: true, policy: "auto" }];
    const result = plan({ images: [image("agents-production-blue", "bot")], apps });
    expect(reasonFor(result, "agents-production-blue-bot:latest")).toBe("system-managed");
  });

  it("refuses an app the user pinned", () => {
    const apps: SlotApp[] = [{ name: "agents", isSystemManaged: false, policy: "never" }];
    const result = plan({ images: [image("agents-production-blue", "bot")], apps });
    expect(reasonFor(result, "agents-production-blue-bot:latest")).toBe("pinned-by-user");
  });

  it("refuses a compose project nothing on this host accounts for", () => {
    const result = plan({ images: [image("docs", "docs-app")] });
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result, "docs-docs-app:latest")).toBe("unknown-project");
  });

  it("refuses a registry-qualified tag, which is the other sweep's business", () => {
    const result = plan({
      images: [
        image("agents-production-blue", "bot", { repoTags: ["ghcr.io/acme/bot:1.2.3"] }),
      ],
    });
    expect(result.candidates).toHaveLength(0);
    expect(reasonFor(result, "ghcr.io/acme/bot:1.2.3")).toBe("registry-image");
  });

  it("refuses an untagged image", () => {
    const result = plan({
      images: [image("agents-production-blue", "bot", { repoTags: ["<none>:<none>"] })],
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0].reason).toBe("untagged");
  });

  it("ignores images compose did not build rather than reporting them", () => {
    const result = plan({
      images: [{ id: "sha256:pg", repoTags: ["postgres:17"], size: 9_000, labels: {} }],
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("never names a volume", () => {
    const result = plan({
      images: [image("agents-production-blue", "bot"), image("agents-production-green", "bot")],
    });
    expect(JSON.stringify(result)).not.toContain("volume");
  });
});

describe("selectSlotCandidates — project names with dashes", () => {
  it("resolves an app whose name contains a dash", () => {
    const result = plan({
      images: [image("browser-mcp-production-blue", "browser-mcp")],
      environments: [env({ appName: "browser-mcp", envName: "production", currentSlot: "green" })],
    });
    expect(result.candidates[0].generation).toEqual({
      kind: "slot",
      appName: "browser-mcp",
      envName: "production",
      slot: "blue",
    });
  });

  it("resolves a preview environment whose name contains a dash", () => {
    const result = plan({
      images: [image("agents-pr-166-green", "bot")],
      environments: [env({ appName: "agents", envName: "pr-166", currentSlot: "blue" })],
    });
    expect(result.candidates[0].generation).toEqual({
      kind: "slot",
      appName: "agents",
      envName: "pr-166",
      slot: "green",
    });
  });

  it("does not let one app's environment claim another app's project", () => {
    const result = plan({
      images: [image("agents-pr-166-green", "bot")],
      environments: [env({ appName: "agents", envName: "production", currentSlot: "blue" })],
    });
    expect(reasonFor(result, "agents-pr-166-green-bot:latest")).toBe("unknown-project");
  });
});

describe("selectSlotCandidates — determinism", () => {
  it("returns the same plan for the same input", () => {
    const images = [
      image("agents-production-blue", "bot"),
      image("agents-production-green", "bot"),
      image("docs", "docs-app"),
    ];
    expect(plan({ images })).toEqual(plan({ images }));
  });

  it("accounts for every compose-built image as either a candidate or a skip", () => {
    const images = [
      image("agents-production-blue", "bot"),
      image("agents-production-green", "bot"),
      image("docs", "docs-app"),
    ];
    const result = plan({ images });
    const planned = result.candidates.reduce((n, c) => n + c.images.length, 0);
    expect(planned + result.skipped.length).toBe(images.length);
  });
});
