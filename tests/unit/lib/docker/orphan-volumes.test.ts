import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import type { VolumeInfo } from "@/lib/docker/client";
import { deleteOrphanVolumes, ORPHAN_MIN_AGE_MS, resolveOrphans, type OrphanSnapshot } from "@/lib/docker/orphan-volumes";

const now = Date.parse("2026-10-11T12:00:00Z");
const OLD = new Date(now - 30 * ORPHAN_MIN_AGE_MS).toISOString();
const HASH = "a".repeat(64);

const vol = (name: string, labels: Record<string, string> = {}, createdAt: string | undefined = OLD): VolumeInfo => ({
  name,
  mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  labels,
  createdAt,
});

function snapshot(over: Partial<OrphanSnapshot> = {}): OrphanSnapshot {
  return {
    volumes: [],
    mounted: new Set(),
    containerProjects: new Set(),
    liveVolumes: new Set(),
    liveAppNames: new Set(),
    keptByDeletedApp: new Map(),
    dirNames: [],
    recordNames: new Set(),
    composeTexts: [],
    now,
    ...over,
  };
}

const names = (snap: OrphanSnapshot) => resolveOrphans(snap).map((v) => v.name);

describe("resolveOrphans", () => {
  it("lists an old anonymous volume nothing mounts", () => {
    expect(resolveOrphans(snapshot({ volumes: [vol(HASH)] }))).toEqual([
      { name: HASH, kind: "anonymous", project: null, createdAt: OLD },
    ]);
  });

  it("never lists a volume an app record owns", () => {
    const snap = snapshot({ volumes: [vol("pgdata"), vol("shop-production_uploads")], recordNames: new Set(["pgdata"]) });
    snap.liveVolumes.add("shop-production_uploads");
    expect(names(snap)).toEqual([]);
  });

  it("never lists a volume named after or labelled with a live app", () => {
    const snap = snapshot({
      volumes: [vol("shop_cache"), vol("x", { "com.docker.compose.project": "shop-production-green" }), vol(HASH, { "com.docker.compose.project": "shop" })],
      liveAppNames: new Set(["shop"]),
    });
    expect(names(snap)).toEqual([]);
  });

  it("never lists a volume a stopped container still mounts, as an idle slot's", () => {
    expect(names(snapshot({ volumes: [vol("media")], mounted: new Set(["media"]) }))).toEqual([]);
  });

  it("never lists a volume a compose file names", () => {
    const compose = "volumes:\n  media:\n    external: true\n    name: shared-media\n";
    expect(names(snapshot({ volumes: [vol("shared-media"), vol("shared-media-old")], composeTexts: [compose] }))).toEqual(["shared-media-old"]);
  });

  it("never lists Vardo's own volumes, a fresh volume or one with no creation time", () => {
    const snap = snapshot({
      volumes: [vol("vardo_postgres-data"), vol("new", {}, new Date(now - 60_000).toISOString()), { ...vol("undated"), createdAt: undefined }],
    });
    expect(names(snap)).toEqual([]);
  });

  it("leaves detached volumes to their own list", () => {
    const snap = snapshot({ volumes: [vol("blog_db", { "com.docker.compose.project": "blog" })], keptByDeletedApp: new Map([["blog_db", "blog"]]) });
    expect(names(snap)).toEqual([]);
  });
});

describe("deleteOrphanVolumes", () => {
  it("rechecks each name and removes only orphans", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const snap = snapshot({ volumes: [vol(HASH), vol("pgdata")], recordNames: new Set(["pgdata"]) });
    const results = await deleteOrphanVolumes([HASH, "pgdata"], { load: async () => snap, remove });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(HASH);
    expect(results).toEqual([
      { name: HASH, ok: true },
      { name: "pgdata", ok: false, error: "No longer unused" },
    ]);
  });
});
