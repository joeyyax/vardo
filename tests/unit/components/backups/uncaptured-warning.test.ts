import { describe, it, expect } from "vitest";
import { uncapturedSources } from "@/components/backups/uncaptured-warning";
import type { AppVolume } from "@/components/backups/types";

const bind = (over: Partial<AppVolume> = {}): AppVolume => ({
  name: "dashboards",
  type: "bind",
  source: "/var/lib/vardo/apps/obs/blue/dashboards",
  persistent: true,
  durability: null,
  backupStrategy: "tar",
  backupSelection: null,
  configReason: null,
  ...over,
});

const app = (volumes: AppVolume[]) => [{ id: "a1", name: "obs", displayName: "Obs", volumes }];

describe("uncapturedSources", () => {
  it("lists opted-in config the engine skips as not backed up, with the reason", () => {
    const vol = bind({ backupSelection: "include", configReason: "Config from the app's repo" });
    expect(uncapturedSources(app([vol]))).toEqual({
      binds: [],
      config: ["Obs: /var/lib/vardo/apps/obs/blue/dashboards (config from the app's repo)"],
    });
  });

  it("gives opted-out config no config reason", () => {
    const vol = bind({ backupSelection: "exclude", configReason: "Config from the app's repo" });
    expect(uncapturedSources(app([vol])).config).toEqual([]);
  });

  it("counts a stateful or opted-in data bind as captured", () => {
    expect(uncapturedSources(app([bind({ durability: "stateful" }), bind({ backupSelection: "include" })]))).toEqual({
      binds: [],
      config: [],
    });
    expect(uncapturedSources(app([bind()])).binds).toEqual(["Obs: /var/lib/vardo/apps/obs/blue/dashboards"]);
  });
});
