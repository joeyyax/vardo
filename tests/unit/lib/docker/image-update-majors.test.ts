import { afterEach, describe, it, expect } from "vitest";
import { splitCheck, resurfaceReasons, setSecurityAdvisor } from "@/lib/docker/image-updates/majors";
import { selectUpdateCandidate } from "@/lib/docker/image-updates/tag-version";
import { isMajorLocked, ownsDataDirectory } from "@/lib/docker/image-updates/stateful-image";
import {
  defaultTrackMode,
  indexTracks,
  resolveTrack,
} from "@/lib/docker/image-updates/track-policy";

describe("classification", () => {
  it("keeps patch and minor in `latest` and moves majors aside for every image", () => {
    const result = selectUpdateCandidate("5.2.1", ["5.2.2", "5.3.0", "6.0.0", "6.1.0"], { capAtMajor: true });
    expect(result).toMatchObject({ latest: "5.3.0", severity: "minor", majorAvailable: "6.1.0" });
  });

  it("reports only a major when nothing newer exists within the running one", () => {
    const result = selectUpdateCandidate("16", ["16", "17", "18"], { capAtMajor: true });
    expect(result.latest).toBeNull();
    expect(result.majorAvailable).toBe("18");
  });

  it("classifies a patch", () => {
    expect(selectUpdateCandidate("1.25.3", ["1.25.4"], { capAtMajor: true }).severity).toBe("patch");
  });
});

describe("major-locked detection", () => {
  it.each(["postgres:16", "docker.io/library/mysql:8.0", "mariadb:11", "mongo:7", "bitnami/elasticsearch:8", "postgis/postgis:16-3.4"])(
    "%s is major-locked",
    (image) => expect(isMajorLocked(image)).toBe(true),
  );

  it.each(["nginx:1.25", "ghost:5", "redis:7"])("%s is not major-locked", (image) => {
    expect(isMajorLocked(image)).toBe(false);
  });

  it("treats redis and valkey as stateful", () => {
    expect(ownsDataDirectory("redis:7")).toBe(true);
    expect(ownsDataDirectory("valkey/valkey:8")).toBe(true);
    expect(ownsDataDirectory("ghost:5")).toBe(false);
  });
});

describe("splitCheck", () => {
  it("passes a capped row through", () => {
    const split = splitCheck("16.2", {
      latestTag: "16.4",
      severity: "minor",
      available: ["17.1", "17.0", "16.4", "16.3"],
      majorAvailable: "17.1",
    });
    expect(split).toEqual({
      latestTag: "16.4",
      severity: "minor",
      available: ["16.4", "16.3"],
      majorAvailable: "17.1",
      majorTags: ["17.1", "17.0"],
    });
  });

  it("reclassifies an older row that carried a major in latestTag", () => {
    const split = splitCheck("5.2", {
      latestTag: "6.1",
      severity: "major",
      available: ["6.1", "6.0", "5.9"],
      majorAvailable: null,
    });
    expect(split).toMatchObject({ latestTag: "5.9", severity: "minor", majorAvailable: "6.1" });
    expect(split.available).toEqual(["5.9"]);
  });

  it("leaves no update when an older row only had a major", () => {
    const split = splitCheck("16", { latestTag: "17", severity: "major", available: ["17"], majorAvailable: null });
    expect(split.latestTag).toBeNull();
    expect(split.severity).toBeNull();
    expect(split.majorAvailable).toBe("17");
  });
});

describe("track policy", () => {
  it("defaults stateful images to stay on their major and the rest to follow latest", () => {
    expect(defaultTrackMode("postgres:16")).toBe("major");
    expect(defaultTrackMode("redis:7")).toBe("major");
    expect(defaultTrackMode("ghost:5")).toBe("latest");
    expect(defaultTrackMode("nginx:1.25")).toBe("latest");
  });

  it("uses an explicit policy over the default, per service", () => {
    const index = indexTracks([
      { appId: "a", composeService: "db", mode: "latest" },
      { appId: "b", composeService: null, mode: "major" },
    ]);
    expect(resolveTrack(index, "a", "db", "postgres:16")).toEqual({ mode: "latest", explicit: true });
    expect(resolveTrack(index, "a", "cache", "redis:7")).toEqual({ mode: "major", explicit: false });
    expect(resolveTrack(index, "b", null, "ghost:5")).toEqual({ mode: "major", explicit: true });
    expect(resolveTrack(index, undefined, null, "ghost:5")).toEqual({ mode: "latest", explicit: false });
  });
});

describe("resurfaceReasons", () => {
  afterEach(() => setSecurityAdvisor(null));

  it("is empty for a supported major", () => {
    expect(resurfaceReasons({ image: "postgres:17", currentTag: "17", majorAvailable: "18" }, Date.parse("2026-10-10"))).toEqual([]);
  });

  it("returns an EOL reason near the date", () => {
    const reasons = resurfaceReasons({ image: "postgres:14", currentTag: "14", majorAvailable: "18" }, Date.parse("2026-10-10"));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: "eol", notice: { state: "ending" } });
  });

  it("asks the security hook when one is wired", () => {
    setSecurityAdvisor(({ majorAvailable }) =>
      majorAvailable ? { summary: "A fix is only in the new major.", fixedIn: majorAvailable } : null,
    );
    const reasons = resurfaceReasons({ image: "ghost:5", currentTag: "5", majorAvailable: "6" });
    expect(reasons).toEqual([{ kind: "security", advisory: { summary: "A fix is only in the new major.", fixedIn: "6" } }]);
  });
});
