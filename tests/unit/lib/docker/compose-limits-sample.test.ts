// Every service on the sample host keeps room above its observed CPU and process peaks under the #889 defaults.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { buildVardoOverlay, defaultPidsLimit } from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import type { ServiceConfigOverride } from "@/lib/docker/compose-types";

type Peak = { cpuCores: number; pids: number };
type Limits = { cpus?: string; memory?: string; pids?: number | string };
type Entry = {
  app: string;
  env: string;
  trusted: boolean;
  priority: "critical" | "standard" | "disposable" | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean;
  serviceConfig: Record<string, ServiceConfigOverride>;
  base: { services: Record<string, unknown> };
  deployedOverlay: Record<string, { deploy?: { resources?: { limits?: Limits } } }> | null;
  peaks: Record<string, Peak>;
};

const fx: { hostCpus: number; apps: Entry[] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures/sample-limits.json"), "utf-8"),
);

const CPU_MARGIN = 1.1;
const PIDS_MARGIN = 2;

function render(entry: Entry): Record<string, Limits> {
  const overlay = buildVardoOverlay({
    fullCompose: parseCompose(YAML.stringify(entry.base)),
    networkName: "vardo-network",
    cpuLimit: entry.cpuLimit,
    memoryLimit: entry.memoryLimit,
    priority: entry.priority,
    gpuEnabled: entry.gpuEnabled,
    serviceConfig: entry.serviceConfig,
    hostCpus: fx.hostCpus,
  });
  return Object.fromEntries(
    Object.entries(overlay.services).map(([name, svc]) => [name, svc.deploy?.resources?.limits ?? {}]),
  );
}

/** Cores a limit allows. */
function cores(cpus: string | undefined): number {
  return cpus === undefined || Number(cpus) === 0 ? Infinity : Number(cpus);
}

const services = fx.apps.flatMap((entry) =>
  Object.keys(entry.base.services).map((svc) => [`${entry.app}/${svc}`, entry, svc] as const),
);

describe("sample host limits (#889)", () => {
  it("covers the snapshot", () => {
    expect(fx.hostCpus).toBe(32);
    expect(fx.apps.length).toBeGreaterThan(55);
    expect(fx.apps.every((a) => a.trusted)).toBe(true);
  });

  it.each(services)("%s keeps CPU above its peak", (_name, entry, svc) => {
    const peak = entry.peaks[svc]?.cpuCores ?? 0;
    const after = render(entry)[svc];
    const declared = parseCompose(YAML.stringify(entry.base)).services[svc].deploy?.resources?.limits?.cpus;
    const before = entry.deployedOverlay?.[svc]?.deploy?.resources?.limits?.cpus ?? declared;
    // A limit the app or its compose already sets is unchanged; only the new default needs room.
    if (before !== undefined) {
      expect(after.cpus).toBe(String(before));
      return;
    }
    expect(cores(after.cpus)).toBeGreaterThanOrEqual(peak * CPU_MARGIN);
  });

  it.each(services)("%s keeps processes above its peak", (_name, entry, svc) => {
    const peak = entry.peaks[svc]?.pids ?? 0;
    const pids = Number(render(entry)[svc].pids);
    expect(pids).toBeGreaterThanOrEqual(peak * PIDS_MARGIN);
  });

  it.each(services)("%s keeps its memory limit", (_name, entry, svc) => {
    const before = entry.deployedOverlay?.[svc]?.deploy?.resources?.limits?.memory;
    if (before === undefined) return;
    expect(render(entry)[svc].memory).toBe(before);
  });

  it("lands the heaviest services where the report says", () => {
    const at = (app: string, svc: string) => render(fx.apps.find((a) => a.app === app)!)[svc];
    expect(at("notes-api", "notes-embed").cpus).toBe("31");
    expect(at("media-server", "media-server").cpus).toBe("31");
    expect(at("camera-hub", "camera-hub").cpus).toBeUndefined();
    expect(at("browser-api", "browser-api").cpus).toBe("4");
    expect(at("vardo", "buildkit").pids).toBe(defaultPidsLimit());
  });
});
