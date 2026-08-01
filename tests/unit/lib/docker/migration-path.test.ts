import { describe, it, expect } from "vitest";
import { isMajorLocked } from "@/lib/docker/image-updates/stateful-image";
import { majorOf, migrationPathFor, planMigration } from "@/lib/docker/image-updates/migration-path";
import { selectUpdateCandidate } from "@/lib/docker/image-updates/tag-version";

describe("isMajorLocked", () => {
  it("flags datastores whose data directory is tied to the major", () => {
    for (const image of ["postgres", "postgres:16", "postgis/postgis", "mysql", "mariadb", "mongo"]) {
      expect(isMajorLocked(image), image).toBe(true);
    }
  });

  it("leaves stateless and forward-compatible images alone", () => {
    for (const image of ["redis:alpine", "nginx", "node:22", "traefik:v3"]) {
      expect(isMajorLocked(image), image).toBe(false);
    }
  });

  it("matches on the repository, not a registry host that happens to contain the name", () => {
    expect(isMajorLocked("ghcr.io/acme/postgres-backup:1")).toBe(true);
    expect(isMajorLocked("docker.getoutline.com/outlinewiki/outline:1.8.1")).toBe(false);
  });
});

describe("selectUpdateCandidate with capAtMajor", () => {
  const postgresTags = ["16", "16.2", "17", "18"];

  it("stops at the current major and offers the major separately", () => {
    const result = selectUpdateCandidate("16", postgresTags, { capAtMajor: true });
    expect(result.latest).toBeNull();
    expect(result.majorAvailable).toBe("18");
  });

  it("still takes the newest tag inside the major", () => {
    const result = selectUpdateCandidate("16", ["16", "17", "18"], { capAtMajor: true });
    expect(result.majorAvailable).toBe("18");
    expect(result.available).toEqual(["18", "17"]);
  });

  it("reproduces the outline failure when uncapped", () => {
    // postgres:16 → 18 against a PG 16 data directory is what broke the deploy.
    expect(selectUpdateCandidate("16", postgresTags).latest).toBe("18");
  });

  it("does not cap images that are not major-locked", () => {
    expect(selectUpdateCandidate("1.2.0", ["1.2.0", "2.0.0"]).latest).toBe("2.0.0");
  });

  it("orders available newest first", () => {
    const result = selectUpdateCandidate("1.0.0", ["1.0.0", "1.2.0", "1.1.0", "2.0.0"]);
    expect(result.available).toEqual(["2.0.0", "1.2.0", "1.1.0"]);
  });
});

describe("majorOf", () => {
  it("reads the leading integer through prefixes and flavors", () => {
    expect(majorOf("16")).toBe(16);
    expect(majorOf("16.2-alpine")).toBe(16);
    expect(majorOf("v3.1.2")).toBe(3);
    expect(majorOf("alpine")).toBeNull();
  });
});

describe("planMigration", () => {
  it("lets postgres jump majors in one move", () => {
    const plan = planMigration("postgres:16", "16", "18")!;
    expect(plan.strategy).toBe("dump-restore");
    expect(plan.hops).toEqual([18]);
    expect(plan.needsIntermediateSteps).toBe(false);
  });

  it("expands the intermediate majors an engine cannot skip", () => {
    // Mongo refuses a data dir more than one major behind, so 4 → 7 is three moves.
    const plan = planMigration("mongo:4", "4", "7")!;
    expect(plan.hops).toEqual([5, 6, 7]);
    expect(plan.needsIntermediateSteps).toBe(true);
  });

  it("substitutes the versions into the steps", () => {
    const plan = planMigration("postgres:16", "16", "18")!;
    expect(plan.steps.some((s) => s.includes("18"))).toBe(true);
    expect(plan.steps.join(" ")).not.toContain("{to}");
  });

  it("returns null for a downgrade, an equal move, or an unversioned tag", () => {
    expect(planMigration("postgres:16", "18", "16")).toBeNull();
    expect(planMigration("postgres:16", "16", "16")).toBeNull();
    expect(planMigration("postgres:16", "alpine", "18")).toBeNull();
  });

  it("returns null for an image with no major lock", () => {
    expect(migrationPathFor("redis:alpine")).toBeNull();
    expect(planMigration("redis:7", "7", "8")).toBeNull();
  });
});
