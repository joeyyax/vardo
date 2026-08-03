import { describe, expect, it } from "vitest";

import {
  buildSlotIndex,
  classifyProject,
  decideSlotImage,
  slotImageRef,
  SLOT_SKIP_COPY,
  type SlotEnvironment,
  type SlotGeneration,
} from "@/lib/docker/image-reclaim/slot-policy";

const ENVIRONMENTS: SlotEnvironment[] = [
  { appName: "agents", envName: "production", currentSlot: "green" },
  { appName: "browser-mcp", envName: "production", currentSlot: "blue" },
  { appName: "agents", envName: "pr-166", currentSlot: "blue" },
];

const INDEX = buildSlotIndex(ENVIRONMENTS);

const SLOT_BLUE: SlotGeneration = {
  kind: "slot",
  appName: "agents",
  envName: "production",
  slot: "blue",
};

describe("classifyProject", () => {
  it("resolves the current scheme", () => {
    expect(classifyProject("agents-production-blue", INDEX)).toEqual(SLOT_BLUE);
  });

  it("resolves app and environment names that contain dashes", () => {
    expect(classifyProject("browser-mcp-production-green", INDEX)).toEqual({
      kind: "slot",
      appName: "browser-mcp",
      envName: "production",
      slot: "green",
    });
    expect(classifyProject("agents-pr-166-green", INDEX)).toEqual({
      kind: "slot",
      appName: "agents",
      envName: "pr-166",
      slot: "green",
    });
  });

  it("resolves the pre-slot schemes", () => {
    expect(classifyProject("agents", INDEX)).toEqual({ kind: "legacy", appName: "agents" });
    expect(classifyProject("agents-production", INDEX)).toEqual({
      kind: "legacy",
      appName: "agents",
    });
  });

  it("resolves bare blue and green, the oldest scheme, without an app", () => {
    expect(classifyProject("blue", INDEX)).toEqual({ kind: "legacy", appName: null });
    expect(classifyProject("green", INDEX)).toEqual({ kind: "legacy", appName: null });
  });

  it("returns null for a project no environment accounts for", () => {
    expect(classifyProject("docs", INDEX)).toBeNull();
    expect(classifyProject("agents-staging-blue", INDEX)).toBeNull();
  });
});

describe("decideSlotImage", () => {
  function decide(overrides: Partial<Parameters<typeof decideSlotImage>[0]> = {}) {
    return decideSlotImage({
      generation: SLOT_BLUE,
      currentSlot: "green",
      projectHasContainers: false,
      app: null,
      ...overrides,
    });
  }

  it("takes a superseded slot with no containers", () => {
    expect(decide()).toEqual({ take: true });
  });

  it("refuses the slot 'current' names", () => {
    expect(decide({ currentSlot: "blue" })).toEqual({ take: false, reason: "live-slot" });
  });

  it("refuses both slots when 'current' is unreadable", () => {
    expect(decide({ currentSlot: null })).toEqual({ take: false, reason: "current-unreadable" });
  });

  it("refuses a slot that still has containers", () => {
    expect(decide({ projectHasContainers: true })).toEqual({ take: false, reason: "slot-in-use" });
  });

  it("puts the unreadable symlink ahead of the container check", () => {
    // Both refuse, but "we cannot tell which slot is live" is the stronger claim.
    expect(decide({ currentSlot: null, projectHasContainers: true })).toEqual({
      take: false,
      reason: "current-unreadable",
    });
  });

  it("ignores 'current' for a legacy project, which no symlink can name", () => {
    const generation: SlotGeneration = { kind: "legacy", appName: "agents" };
    expect(decide({ generation, currentSlot: null })).toEqual({ take: true });
  });

  it("refuses Vardo itself, by app row or by project attribution", () => {
    const self = { name: "vardo", isSystemManaged: false, policy: "auto" as const };
    expect(decide({ app: self })).toEqual({ take: false, reason: "self" });
    expect(
      decide({ generation: { kind: "legacy", appName: "vardo" } }),
    ).toEqual({ take: false, reason: "self" });
  });

  it("refuses system-managed and user-pinned apps", () => {
    expect(decide({ app: { name: "agents", isSystemManaged: true, policy: "auto" } })).toEqual({
      take: false,
      reason: "system-managed",
    });
    expect(decide({ app: { name: "agents", isSystemManaged: false, policy: "never" } })).toEqual({
      take: false,
      reason: "pinned-by-user",
    });
  });

  it("takes an unattributed legacy generation — nothing live can reference it", () => {
    expect(decide({ generation: { kind: "legacy", appName: null } })).toEqual({ take: true });
  });
});

describe("slotImageRef", () => {
  it("takes compose's own unqualified build tag", () => {
    expect(slotImageRef(["agents-production-blue-bot:latest"])).toEqual({
      take: true,
      ref: "agents-production-blue-bot:latest",
    });
  });

  it("refuses a registry-qualified tag", () => {
    expect(slotImageRef(["ghcr.io/acme/bot:1.2.3"])).toEqual({
      take: false,
      reason: "registry-image",
    });
  });

  it("refuses when any tag is registry-qualified", () => {
    expect(slotImageRef(["local-bot:latest", "ghcr.io/acme/bot:1.2.3"]).take).toBe(false);
  });

  it("refuses an untagged image", () => {
    expect(slotImageRef([])).toEqual({ take: false, reason: "untagged" });
    expect(slotImageRef(["<none>:<none>"])).toEqual({ take: false, reason: "untagged" });
  });
});

describe("SLOT_SKIP_COPY", () => {
  it("explains every refusal reason", () => {
    const reasons = [
      "self",
      "system-managed",
      "pinned-by-user",
      "live-slot",
      "current-unreadable",
      "slot-in-use",
      "registry-image",
      "untagged",
      "unknown-project",
    ] as const;
    for (const reason of reasons) {
      expect(SLOT_SKIP_COPY[reason]).toBeTruthy();
    }
  });
});
