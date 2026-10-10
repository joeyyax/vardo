import { describe, it, expect } from "vitest";
import { channelHasUpdate, parseCompare } from "@/lib/version";
import { dumpFileName, dumpsToPrune, dumpTarget } from "@/lib/self-update/dump";
import { vardoUpdateRow } from "@/lib/attention/vardo-update-row";
import type { ChannelUpdate } from "@/lib/version";

describe("channelHasUpdate", () => {
  it("is false for the build's own commit", () => {
    expect(channelHasUpdate("abc1234", "abc1234def", null)).toBe(false);
  });

  it("follows GitHub's compare: ahead is news, behind is not", () => {
    expect(channelHasUpdate("abc1234", "def5678", { status: "ahead", aheadBy: 3 })).toBe(true);
    expect(channelHasUpdate("abc1234", "def5678", { status: "behind", aheadBy: 0 })).toBe(false);
    expect(channelHasUpdate("abc1234", "def5678", { status: "diverged", aheadBy: 2 })).toBe(true);
  });

  it("assumes an update when GitHub couldn't compare", () => {
    expect(channelHasUpdate("abc1234", "def5678", null)).toBe(true);
  });

  it("reads the compare body", () => {
    expect(parseCompare({ status: "ahead", ahead_by: 7 })).toEqual({ status: "ahead", aheadBy: 7, commits: [] });
    expect(parseCompare({ status: "weird" })).toBeNull();
  });

  it("keeps the newest commits' first lines, short shas and authors, and the compare page", () => {
    const commit = (n: number) => ({
      sha: `${String(n).padStart(2, "0")}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9`,
      commit: { message: `feat: change ${n}\n\nBody text`, author: { name: "Dev Example" } },
      author: { login: "dev" },
    });
    const parsed = parseCompare({
      status: "ahead",
      ahead_by: 12,
      html_url: "https://github.com/example/vardo/compare/abc1234...def5678",
      commits: Array.from({ length: 12 }, (_, i) => commit(i + 1)),
    })!;
    expect(parsed.url).toBe("https://github.com/example/vardo/compare/abc1234...def5678");
    expect(parsed.commits).toHaveLength(10);
    expect(parsed.commits[0]).toEqual({ sha: "12a1b2c", subject: "feat: change 12", author: "Dev Example" });
    expect(parsed.commits.at(-1)?.subject).toBe("feat: change 3");
  });

  it("drops a compare page that isn't https and commits without a sha", () => {
    const parsed = parseCompare({ status: "ahead", ahead_by: 1, html_url: "javascript:alert(1)", commits: [{ sha: "nope" }] })!;
    expect(parsed.url).toBeUndefined();
    expect(parsed.commits).toEqual([]);
  });
});

describe("pre-update dump", () => {
  it("dumps the database DATABASE_URL names", () => {
    expect(dumpTarget("postgresql://host:secret@vardo-postgres:5432/host")).toEqual({ user: "host", database: "host" });
    expect(dumpTarget("postgresql://vardo:x@db:5432/vardo_prod")).toEqual({ user: "vardo", database: "vardo_prod" });
    expect(dumpTarget("postgresql://a;rm:x@db/b c")).toEqual({ user: "host", database: "host" });
    expect(dumpTarget(undefined)).toEqual({ user: "host", database: "host" });
  });

  it("names dumps by time and keeps the newest three", () => {
    expect(dumpFileName(new Date("2026-10-09T03:04:05.678Z"))).toBe("pre-update-20261009T030405Z.sql.gz");
    const names = ["pre-update-20261001T000000Z.sql.gz", "pre-update-20261003T000000Z.sql.gz", "pre-update-20261002T000000Z.sql.gz", "pre-update-20261004T000000Z.sql.gz", "other.txt"];
    expect(dumpsToPrune(names)).toEqual(["pre-update-20261001T000000Z.sql.gz"]);
  });
});

describe("vardoUpdateRow", () => {
  const update: ChannelUpdate = {
    channel: "main",
    localSha: "abc1234",
    targetSha: "def5678901234567890123456789012345678901",
    targetLabel: "def5678",
    commitsBehind: 3,
    hasUpdate: true,
    url: "https://github.com/joeyyax/vardo/commits/main",
    commits: [],
  };

  it("offers Update now on a self-deploy instance", () => {
    const row = vardoUpdateRow({ update, currentVersion: "0.1.0 (abc1234)", selfDeploy: true, runActive: false })!;
    expect(row.items[0].name).toBe("Vardo update available · 3 commits");
    expect(row.action).toMatchObject({ label: "Update now", post: "/api/v1/admin/maintenance/update" });
  });

  it("points a legacy install at the host command", () => {
    const row = vardoUpdateRow({ update, currentVersion: "0.1.0", selfDeploy: false, runActive: false })!;
    expect(row.action).toEqual({ label: "Update instructions", href: "/admin/settings/maintenance#updates" });
    expect(row.footer).toContain("sudo vardo update");
  });

  it("names the release on the releases channel", () => {
    const row = vardoUpdateRow({ update: { ...update, channel: "releases", targetLabel: "v0.2.0" }, currentVersion: "0.1.0", selfDeploy: true, runActive: false })!;
    expect(row.items[0].name).toBe("Vardo v0.2.0 available");
  });

  it("shows a running update, and nothing when up to date", () => {
    expect(vardoUpdateRow({ update, currentVersion: "0.1.0", selfDeploy: true, runActive: true })?.label).toBe("Vardo updating");
    expect(vardoUpdateRow({ update: { ...update, hasUpdate: false }, currentVersion: "0.1.0", selfDeploy: true, runActive: false })).toBeNull();
    expect(vardoUpdateRow({ update: null, currentVersion: "0.1.0", selfDeploy: true, runActive: false })).toBeNull();
  });
});
