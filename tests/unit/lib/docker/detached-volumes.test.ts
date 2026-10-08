import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import type { VolumeInfo } from "@/lib/docker/client";
import {
  resolveDetached,
  deleteDetachedVolume,
  NotDetachedError,
  type Snapshot,
} from "@/lib/docker/detached-volumes";

const vol = (name: string, project?: string): VolumeInfo => ({
  name,
  mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  labels: project ? { "com.docker.compose.project": project } : {},
});

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    volumes: [],
    mounted: new Set(),
    containerProjects: new Set(),
    liveVolumes: new Set(),
    liveAppNames: new Set(),
    keptByDeletedApp: new Map(),
    dirNames: [],
    ...over,
  };
}

describe("resolveDetached", () => {
  it("lists a volume the delete record kept", () => {
    const snap = snapshot({
      volumes: [vol("blog_db", "blog")],
      keptByDeletedApp: new Map([["blog_db", "blog"]]),
    });
    expect(resolveDetached(snap).volumes).toEqual([{ name: "blog_db", sourceApp: "blog" }]);
  });

  it("lists a volume whose project matches an orphaned app directory", () => {
    const snap = snapshot({ volumes: [vol("blog-green_db", "blog-green")], dirNames: ["blog"] });
    expect(resolveDetached(snap).volumes).toEqual([{ name: "blog-green_db", sourceApp: "blog" }]);
  });

  it("ignores a compose project Vardo has no record of", () => {
    const snap = snapshot({ volumes: [vol("vardo_postgres_data", "vardo"), vol("ddev-global-cache", "ddev")] });
    expect(resolveDetached(snap).volumes).toEqual([]);
  });

  it("never lists a volume a live app owns", () => {
    const snap = snapshot({
      volumes: [vol("blog_db", "blog")],
      keptByDeletedApp: new Map([["blog_db", "blog"]]),
      liveVolumes: new Set(["blog_db"]),
      liveAppNames: new Set(["blog"]),
    });
    expect(resolveDetached(snap).volumes).toEqual([]);
  });

  it("never lists a volume a container mounts or a project a container still runs", () => {
    const kept = new Map([["a_data", "a"], ["b_data", "b"]]);
    const snap = snapshot({
      volumes: [vol("a_data", "a"), vol("b_data", "b")],
      keptByDeletedApp: kept,
      mounted: new Set(["a_data"]),
      containerProjects: new Set(["b"]),
    });
    expect(resolveDetached(snap).volumes).toEqual([]);
  });

  it("never lists Vardo's own project or directory", () => {
    const snap = snapshot({
      volumes: [vol("vardo_postgres_data", "vardo")],
      keptByDeletedApp: new Map([["vardo_postgres_data", "vardo"]]),
      dirNames: ["vardo"],
    });
    const out = resolveDetached(snap);
    expect(out.volumes).toEqual([]);
    expect(out.dirs).toEqual([]);
  });

  it("lists only directories no live app names", () => {
    const snap = snapshot({ dirNames: ["live", "gone"], liveAppNames: new Set(["live"]) });
    expect(resolveDetached(snap).dirs.map((d) => d.name)).toEqual(["gone"]);
  });
});

describe("deleteDetachedVolume", () => {
  const detachedSnap = snapshot({
    volumes: [vol("blog_db", "blog")],
    keptByDeletedApp: new Map([["blog_db", "blog"]]),
  });

  it("removes a detached volume, only that one, without force", async () => {
    const remove = vi.fn(async () => {});
    await deleteDetachedVolume("blog_db", { load: async () => detachedSnap, remove });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("blog_db");
  });

  it("refuses a volume a live app still references", async () => {
    const live = snapshot({
      ...detachedSnap,
      liveVolumes: new Set(["blog_db"]),
      liveAppNames: new Set(["blog"]),
    });
    const remove = vi.fn(async () => {});
    await expect(deleteDetachedVolume("blog_db", { load: async () => live, remove })).rejects.toBeInstanceOf(NotDetachedError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a volume nothing flagged as detached", async () => {
    const remove = vi.fn(async () => {});
    await expect(deleteDetachedVolume("vardo_postgres_data", { load: async () => detachedSnap, remove })).rejects.toBeInstanceOf(NotDetachedError);
    expect(remove).not.toHaveBeenCalled();
  });
});
