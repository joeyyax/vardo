import { describe, it, expect } from "vitest";
import {
  checkDataVersion,
  parseDataVersion,
  versionProbeFor,
} from "@/lib/docker/image-updates/data-version";
import { migrationPathFor } from "@/lib/docker/image-updates/migration-path";

describe("parseDataVersion", () => {
  it("reads the major off the stamp formats each engine writes", () => {
    expect(parseDataVersion("16\n")).toBe(16);
    expect(parseDataVersion("16.2")).toBe(16);
    expect(parseDataVersion("10.11.2-MariaDB")).toBe(10);
    expect(parseDataVersion("")).toBeNull();
    expect(parseDataVersion("garbage")).toBeNull();
  });
});

describe("versionProbeFor", () => {
  it("knows where postgres records its data version", () => {
    expect(versionProbeFor("postgres:16")).toContain("PG_VERSION");
  });

  it("has nothing to read for a stateless image", () => {
    expect(versionProbeFor("nginx:1.27")).toBeNull();
  });
});

describe("checkDataVersion", () => {
  it("passes when the data directory matches the image major", () => {
    expect(checkDataVersion("postgres", "16", "16\n")).toEqual({ kind: "ok" });
  });

  it("catches the outline failure before the deploy stops the old slot", () => {
    const verdict = checkDataVersion("postgres", "18", "16\n");
    expect(verdict.kind).toBe("mismatch");
    if (verdict.kind !== "mismatch") throw new Error("expected a mismatch");
    expect(verdict.onDisk).toBe(16);
    expect(verdict.image).toBe(18);
    expect(verdict.message).toContain("refuse to start");
  });

  it("catches a downgrade too, which fails the same way", () => {
    const verdict = checkDataVersion("postgres", "16", "18\n");
    expect(verdict).toMatchObject({ kind: "mismatch", onDisk: 18, image: 16 });
  });

  it("compares majors only, so a minor bump passes", () => {
    expect(checkDataVersion("postgres", "16.4", "16").kind).toBe("ok");
  });

  it("stays quiet rather than guessing when there is no stamp", () => {
    expect(checkDataVersion("postgres", "18", null).kind).toBe("unknown");
    expect(checkDataVersion("postgres", "18", "   ").kind).toBe("unknown");
    expect(checkDataVersion("postgres", "alpine", "16").kind).toBe("unknown");
  });
});

describe("the index carries rules, not versions", () => {
  // The maintenance worry: an index full of version numbers needs editing every
  // release. These assertions fail if one ever creeps in.
  it("encodes no concrete version numbers in any migration recipe", () => {
    for (const image of ["postgres", "mysql", "mariadb", "mongo", "elasticsearch"]) {
      const path = migrationPathFor(image)!;
      const text = path.steps.join(" ");
      expect(text.replace(/\{from\}|\{to\}/g, ""), image).not.toMatch(/\b\d+\.\d+\b/);
    }
  });

  it("expresses jump limits as a rule so a new major needs no code change", () => {
    // Postgres 18 → 19, whenever it lands, is already handled.
    expect(migrationPathFor("postgres")!.maxMajorJump).toBe(Infinity);
    expect(migrationPathFor("mongo")!.maxMajorJump).toBe(1);
  });
});
