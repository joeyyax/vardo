// #874: what an enrolled app backs up by default. Paths mirror a real host:
// app config under /mnt/docker/<app>, NFS media and downloads, scratch and
// cache datasets, whole-tree mounts and a 160 GB model store.

import { describe, it, expect } from "vitest";
import {
  AUTO_INCLUDE_MAX_BYTES,
  appsWithBackupState,
  classifyVolume,
  fsTypeOf,
  parseMounts,
  type SelectableVolume,
  type SelectionContext,
} from "@/lib/backups/selection";
import { isBackupSelected } from "@/lib/backups/durability";
import { isUncapturedSource } from "@/lib/backups/coverage";

const MOUNTS = parseMounts(
  [
    "tank/subvol-109-disk-0 / zfs rw 0 0",
    "rpool/ROOT/pve-1 /mnt/docker zfs rw 0 0",
    "tank/scratch /mnt/scratch zfs rw 0 0",
    "192.0.2.20:/var/nfs/shared/Media /mnt/media nfs rw,vers=3 0 0",
    "192.0.2.20:/var/nfs/shared/Downloads /mnt/downloads nfs rw,vers=3 0 0",
    "192.0.2.20:/var/nfs/shared/NVR /mnt/nvr nfs4 rw 0 0",
    "192.0.2.20:/var/nfs/shared/Clients /mnt/clients nfs rw 0 0",
  ].join("\n"),
);

const OTHER_BINDS: SelectionContext["otherBinds"] = [
  { appId: "code-server", appName: "code-server", source: "/mnt/docker" },
  { appId: "dockge", appName: "dockge", source: "/mnt/docker" },
  { appId: "gitea", appName: "gitea", source: "/mnt/docker/gitea/data" },
  { appId: "n8n", appName: "n8n", source: "/mnt/docker/n8n/data" },
  { appId: "ollama", appName: "ollama", source: "/mnt/docker/ollama/data" },
  { appId: "llm-proxy", appName: "llm-proxy", source: "/mnt/docker/ollama/data/models/blobs" },
  { appId: "plex", appName: "plex", source: "/mnt/media/Movies" },
  { appId: "radarr", appName: "radarr", source: "/mnt/media/Movies" },
];

function bind(appId: string, source: string, mountPath = "/data"): SelectableVolume {
  return {
    id: `${appId}:${source}`,
    appId,
    name: mountPath.replace(/\//g, "-").replace(/^-/, ""),
    mountPath,
    type: "bind",
    source,
    persistent: false,
    durability: null,
    backupStrategy: "tar",
    backupSelection: null,
  };
}

function named(appId: string, name: string, mountPath = "/data"): SelectableVolume {
  return {
    id: `${appId}:${name}`,
    appId,
    name,
    mountPath,
    type: "named",
    source: `/var/lib/docker/volumes/${appId}_${name}/_data`,
    persistent: true,
    durability: null,
    backupStrategy: "tar",
    backupSelection: null,
  };
}

const ctx = (over: Partial<SelectionContext> = {}): SelectionContext => ({
  otherBinds: OTHER_BINDS,
  hostMounts: MOUNTS,
  ...over,
});

const verdict = (vol: SelectableVolume, over: Partial<SelectionContext> = {}) =>
  classifyVolume(vol, ctx(over)).verdict;

describe("classifyVolume — app state is included", () => {
  it("includes a named volume", () => {
    expect(verdict(named("app", "data"))).toBe("include");
  });

  it("includes an app-owned bind under the docker data tree", () => {
    expect(verdict(bind("n8n", "/mnt/docker/n8n/data", "/home/node/.n8n"))).toBe("include");
    expect(verdict(bind("notes-api", "/mnt/docker/notes-api/content", "/data/content"))).toBe("include");
  });

  it("includes a single config file bind", () => {
    expect(verdict(bind("cloudflare-ddns", "/mnt/docker/cloudflare-ddns/config.json", "/config.json"))).toBe(
      "include",
    );
  });
});

describe("classifyVolume — excluded by rule", () => {
  it.each([
    ["NFS media", "/mnt/media/TV", "Network share (nfs)"],
    ["NFS downloads subtree", "/mnt/downloads/completed", "Network share (nfs)"],
    ["NFS4 recordings", "/mnt/nvr", "Network share (nfs4)"],
    ["NFS client data", "/mnt/clients", "Network share (nfs)"],
  ])("excludes %s", (_label, source, reason) => {
    expect(classifyVolume(bind("app", source), ctx())).toEqual({ verdict: "exclude", reason });
  });

  it("excludes the Docker socket", () => {
    expect(verdict(bind("dozzle", "/var/run/docker.sock", "/var/run/docker.sock"))).toBe("exclude");
    expect(verdict(bind("x", "/srv/run/agent.sock"))).toBe("exclude");
  });

  it.each(["/etc/localtime", "/dev/net/tun", "/usr/bin/docker", "/home/user/working", "/root/.ssh", "/proc"])(
    "excludes host path %s",
    (source) => {
      expect(verdict(bind("app", source))).toBe("exclude");
    },
  );

  it("excludes a whole-tree mount of /mnt/docker", () => {
    const decision = classifyVolume(bind("samba", "/mnt/docker", "/lh-docker"), ctx());
    expect(decision.verdict).toBe("exclude");
    expect(decision.reason).toMatch(/^Whole tree shared with/);
  });

  it("does not let a whole-tree mount make every app's own data foreign", () => {
    expect(verdict(bind("gitea", "/mnt/docker/gitea/data"))).toBe("include");
  });

  it("excludes a path inside another app's mount", () => {
    expect(classifyVolume(bind("llm-proxy", "/mnt/docker/ollama/data/models/blobs", "/models"), ctx())).toEqual({
      verdict: "exclude",
      reason: "Inside ollama's mount",
    });
  });

  it("excludes scratch, cache and download space by name", () => {
    expect(verdict(bind("sabnzbd", "/mnt/scratch/sabnzbd-incomplete-downloads"))).toBe("exclude");
    expect(verdict(bind("plex", "/mnt/cache/plex/cache"))).toBe("exclude");
    expect(verdict(bind("jellyfin", "/mnt/docker/jellyfin/cache", "/cache"))).toBe("exclude");
    expect(verdict(named("app", "build-cache", "/cache"))).toBe("exclude");
  });

  it("keeps an app's own media directory — only top-level shares are excluded", () => {
    expect(verdict(bind("paperless", "/mnt/docker/paperless/media", "/usr/src/paperless/media"))).toBe("include");
  });
});

describe("classifyVolume — size threshold", () => {
  const ollama = bind("ollama", "/mnt/docker/ollama/data", "/root/.ollama");

  it("lists a volume over the limit for opt-in instead of including it", () => {
    const decision = classifyVolume(ollama, ctx({ sizeBytes: 163 * 1024 ** 3 }));
    expect(decision.verdict).toBe("opt-in");
    expect(decision.reason).toBe("163.0 GB, over the 10.0 GB limit");
  });

  it("includes the same volume under the limit", () => {
    expect(verdict(ollama, { sizeBytes: 2 * 1024 ** 3 })).toBe("include");
  });

  it("applies to named volumes too", () => {
    expect(verdict(named("app", "data"), { sizeBytes: AUTO_INCLUDE_MAX_BYTES + 1 })).toBe("opt-in");
  });

  it("lists a volume it could not measure", () => {
    expect(verdict(ollama, { sizeBytes: null })).toBe("opt-in");
  });

  it("lists a model store by name whatever its size", () => {
    expect(verdict(bind("notes-api", "/mnt/docker/notes-api/embed-models"), { sizeBytes: 650e6 })).toBe(
      "opt-in",
    );
  });
});

describe("classifyVolume — explicit choices win", () => {
  it("honors an opt-in on an excluded path and an opt-out on app state", () => {
    expect(verdict({ ...bind("app", "/mnt/media"), backupSelection: "include" })).toBe("include");
    expect(verdict({ ...named("app", "data"), backupSelection: "exclude" })).toBe("exclude");
  });

  it("includes a database dump and excludes a rebuildable volume", () => {
    expect(verdict({ ...bind("gitea", "/mnt/docker/gitea/postgres"), backupStrategy: "dump" })).toBe("include");
    expect(verdict({ ...named("app", "data"), durability: "rebuildable" })).toBe("exclude");
  });
});

describe("selection reaches the engine", () => {
  it("captures an included bind and skips an excluded named volume", () => {
    const included = { ...bind("app", "/mnt/docker/app/data"), backupSelection: "include" as const };
    expect(isBackupSelected(included)).toBe(true);
    expect(isUncapturedSource(included)).toBe(false);
    expect(isBackupSelected({ ...named("app", "big"), backupSelection: "exclude" })).toBe(false);
  });

  it("leaves unselected volumes on the legacy rule", () => {
    expect(isBackupSelected(named("app", "data"))).toBe(true);
    expect(isBackupSelected(bind("app", "/mnt/docker/app/data"))).toBe(false);
  });
});

describe("host mount table", () => {
  it("resolves a path to its longest mount point", () => {
    expect(fsTypeOf("/mnt/media/Movies", MOUNTS)).toBe("nfs");
    expect(fsTypeOf("/mnt/docker/gitea", MOUNTS)).toBe("zfs");
    expect(fsTypeOf("/opt/vardo", MOUNTS)).toBe("zfs");
    expect(fsTypeOf("/anything", new Map())).toBeNull();
  });

  it("decodes escaped spaces", () => {
    expect([...parseMounts("srv:/x /mnt/my\\040share nfs rw 0 0").keys()]).toEqual(["/mnt/my share"]);
  });
});

describe("appsWithBackupState", () => {
  it("counts an app with app state and skips one holding only shared media", () => {
    const rows = [
      { ...bind("n8n", "/mnt/docker/n8n/data"), appName: "n8n" },
      { ...bind("plex", "/mnt/media/Movies"), appName: "plex" },
    ];
    expect(appsWithBackupState(rows, MOUNTS)).toEqual(new Set(["n8n"]));
  });
});
