import { describe, it, expect } from "vitest";
import { CAPABILITIES, can, capabilitiesFor, type Capability } from "@/lib/auth/permissions";

const ADMIN_ONLY: Capability[] = [
  "org.settings",
  "org.members.manage",
  "org.digest.manage",
  "org.transfers.manage",
  "mesh.peers.view",
  "project.delete",
  "app.gpu",
  "app.debug",
  "app.delete",
  "app.volumes.sync",
  "backup.restore",
  "backup.download",
  "backup.delete",
  "backup.targets.manage",
  "backup.jobs.manage",
];

const OWNER_ONLY: Capability[] = ["org.delete", "org.ownership.transfer"];

describe("capability map", () => {
  it.each(ADMIN_ONLY)("%s is for owners and admins", (cap) => {
    expect(can("owner", cap)).toBe(true);
    expect(can("admin", cap)).toBe(true);
    expect(can("member", cap)).toBe(false);
    expect(can("viewer", cap)).toBe(false);
  });

  it.each(OWNER_ONLY)("%s is for the owner", (cap) => {
    expect(can("owner", cap)).toBe(true);
    expect(can("admin", cap)).toBe(false);
  });

  it("gives every other capability to members", () => {
    const rest = (Object.keys(CAPABILITIES) as Capability[]).filter(
      (c) => !ADMIN_ONLY.includes(c) && !OWNER_ONLY.includes(c),
    );
    for (const cap of rest) expect(can("member", cap), cap).toBe(true);
  });

  it("keeps a viewer to reading", () => {
    expect(capabilitiesFor("viewer").sort()).toEqual(["app.view", "org.view"]);
  });

  it("grants nothing to a missing or unknown role", () => {
    expect(can(null, "org.view")).toBe(false);
    expect(can("superuser", "org.view")).toBe(false);
  });
});
