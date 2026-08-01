import { describe, expect, it } from "vitest";
import {
  classifyBump,
  compareTags,
  isFloatingTag,
  parseTag,
  selectUpdateCandidate,
} from "@/lib/docker/image-updates/tag-version";

describe("parseTag", () => {
  const versions: Array<[string, Partial<ReturnType<typeof parseTag>>]> = [
    ["1.26.2", { kind: "version", prefix: "", release: [1, 26, 2] }],
    ["v2.24.0", { kind: "version", prefix: "v", release: [2, 24, 0] }],
    ["26.1", { kind: "version", release: [26, 1] }],
    ["9", { kind: "version", release: [9] }],
    ["2025.7.1", { kind: "version", release: [2025, 7, 1] }],
    ["4.0.17.2952-ls314", { kind: "version", release: [4, 0, 17, 2952], lsBuild: 314 }],
    ["4.0.17", { kind: "version", release: [4, 0, 17], lsBuild: null }],
    ["2026.6.13-a29cda858", { kind: "version", release: [2026, 6, 13], build: "a29cda858" }],
    ["1.26.2-alpine", { kind: "version", flavor: "alpine" }],
    ["1.21-alpine3.19", { kind: "version", flavor: "alpine", flavorVersion: [3, 19] }],
    ["8.3-fpm-alpine", { kind: "version", flavor: "fpm-alpine" }],
    ["1.2.3-rc1", { kind: "version", prerelease: ["rc", 1] }],
    ["1.2.3-beta.2", { kind: "version", prerelease: ["beta", 2] }],
    ["2.0.0-rc.1-alpine", { kind: "version", prerelease: ["rc", 1], flavor: "alpine" }],
  ];

  it.each(versions)("parses %s as an orderable version", (tag, expected) => {
    expect(parseTag(tag)).toMatchObject(expected);
  });

  const floating = ["latest", "stable", "main", "master", "edge", "nightly", "", "stable-alpine"];
  it.each(floating)("treats %s as floating", (tag) => {
    expect(parseTag(tag).kind).toBe("floating");
    expect(isFloatingTag(tag)).toBe(true);
  });

  // Refused outright: no ordering can be defended for these.
  const unknown = [
    "a29cda858",
    "sha256-abcdef",
    "bookworm",
    "focal",
    "1.26.2-customsuffix",
    "release-2024-q1",
    "20240115.1-weirdthing",
  ];
  it.each(unknown)("refuses to order %s", (tag) => {
    expect(parseTag(tag).kind).toBe("opaque");
    expect(isFloatingTag(tag)).toBe(false);
  });
});

describe("compareTags", () => {
  const ordered: Array<[string, string]> = [
    ["1.26.1", "1.26.2"],
    ["1.26.2", "1.27.0"],
    ["1.9.0", "1.10.0"],
    ["v2.23.9", "v2.24.0"],
    ["2025.7.1", "2025.7.2"],
    ["2025.7.9", "2025.8.0"],
    ["4.0.17.2952-ls314", "4.0.17.2952-ls315"],
    ["4.0.17.2952-ls314", "4.0.18.2960-ls315"],
    ["2026.6.13-a29cda858", "2026.6.14-a29cda858"],
    ["1.2.3-rc1", "1.2.3"],
    ["1.2.3-alpha1", "1.2.3-beta1"],
    ["1.2.3-rc1", "1.2.3-rc2"],
    ["1.26.1-alpine", "1.26.2-alpine"],
    ["1.21-alpine3.19", "1.21-alpine3.20"],
  ];

  it.each(ordered)("orders %s below %s", (lower, higher) => {
    expect(compareTags(lower, higher)).toBe(-1);
    expect(compareTags(higher, lower)).toBe(1);
  });

  it.each(["1.26.2", "v2.24.0", "4.0.17.2952-ls314", "1.2.3-rc1"])(
    "reports %s equal to itself",
    (tag) => {
      expect(compareTags(tag, tag)).toBe(0);
    },
  );

  // Each pair is unorderable for a specific, defensible reason.
  const incomparable: Array<[string, string, string]> = [
    ["2026.6.13-a29cda858", "2026.6.13-b1234567", "same date, opaque build hashes"],
    ["1.26.2", "1.27", "different precision — 1.27 is likely a moving alias"],
    ["4.0.17", "4.0.17.2952-ls314", "short LinuxServer form is not a peer"],
    ["4.0.17.2952", "4.0.17.2952-ls314", "one side has no ls build counter"],
    ["1.26.2", "1.26.2-alpine", "different image variant"],
    ["1.26.2-alpine", "1.26.2-slim", "different image variant"],
    ["1.26.2", "v1.26.2", "different prefix convention"],
    ["latest", "1.26.2", "floating tag has no position"],
    ["a29cda858", "b1234567", "bare commit hashes"],
    ["bookworm", "trixie", "distro names are not versions"],
    ["1.26.2", "1.26.2-customsuffix", "unrecognized suffix"],
  ];

  it.each(incomparable)("cannot order %s against %s (%s)", (a, b) => {
    expect(compareTags(a, b)).toBeNull();
    expect(compareTags(b, a)).toBeNull();
  });
});

describe("classifyBump", () => {
  const cases: Array<[string, string, string]> = [
    ["1.26.2", "1.26.3", "patch"],
    ["1.26.2", "1.27.0", "minor"],
    ["1.26.2", "2.0.0", "major"],
    ["v2.24.0", "v3.0.0", "major"],
    ["4.0.17.2952-ls314", "4.0.17.2952-ls315", "build"],
    ["4.0.17.2952-ls314", "4.0.17.2960-ls315", "patch"],
    ["2025.7.1", "2025.8.0", "minor"],
    ["1.26.2", "1.26.1", "unknown"],
    ["latest", "1.26.2", "unknown"],
  ];

  it.each(cases)("classifies %s to %s as %s", (from, to, expected) => {
    expect(classifyBump(from, to)).toBe(expected);
  });
});

describe("selectUpdateCandidate", () => {
  it("picks the highest orderable tag", () => {
    const result = selectUpdateCandidate("1.26.2", ["1.26.1", "1.26.3", "1.27.0", "1.26.2"]);
    expect(result.latest).toBe("1.27.0");
    expect(result.severity).toBe("minor");
  });

  it("never offers a pre-release to a stable tag", () => {
    const result = selectUpdateCandidate("1.26.2", ["1.27.0-rc1", "1.26.3"]);
    expect(result.latest).toBe("1.26.3");
  });

  it("offers a stable release to a pre-release tag", () => {
    const result = selectUpdateCandidate("1.27.0-rc1", ["1.27.0-rc2", "1.27.0"]);
    expect(result.latest).toBe("1.27.0");
  });

  it("stays inside the current variant", () => {
    const result = selectUpdateCandidate("1.26.2-alpine", ["1.30.0", "1.30.0-slim", "1.27.0-alpine"]);
    expect(result.latest).toBe("1.27.0-alpine");
  });

  it("orders LinuxServer builds by release then ls counter", () => {
    const result = selectUpdateCandidate("4.0.17.2952-ls314", [
      "4.0.17.2952-ls315",
      "4.0.18.2960-ls316",
      "latest",
    ]);
    expect(result.latest).toBe("4.0.18.2960-ls316");
  });

  it("returns nothing for a floating tag", () => {
    const result = selectUpdateCandidate("latest", ["1.26.2", "1.27.0"]);
    expect(result.latest).toBeNull();
    expect(result.comparedCount).toBe(0);
  });

  it("returns nothing when the current tag scheme is unknown", () => {
    expect(selectUpdateCandidate("a29cda858", ["b1234567"]).latest).toBeNull();
  });

  it("reports same-family tags it could not order rather than dropping them", () => {
    const result = selectUpdateCandidate("2026.6.13-a29cda858", [
      "2026.6.13-b1234567",
      "2026.6.20-c7654321",
    ]);
    expect(result.latest).toBe("2026.6.20-c7654321");
    expect(result.unorderable).toEqual(["2026.6.13-b1234567"]);
  });

  it("holds steady when nothing is newer", () => {
    const result = selectUpdateCandidate("1.27.0", ["1.26.9", "1.27.0"]);
    expect(result.latest).toBeNull();
    expect(result.comparedCount).toBeGreaterThan(0);
  });
});
