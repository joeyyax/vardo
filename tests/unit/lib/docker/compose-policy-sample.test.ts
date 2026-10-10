// Every app on the sample host deploys unchanged while its org is trusted, and the untrusted refusals stay the expected ones (#886).

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { composePolicyErrors, type ComposePolicy } from "@/lib/docker/compose-policy";

type Fixture = {
  orgs: Record<string, { trusted: boolean }>;
  apps: { app: string; env: string; org: string; project: string; appDir: string; repoDir: string; config: unknown }[];
};

const fx: Fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/sample-compose-policy.json"), "utf-8"),
);

function refusals(entry: Fixture["apps"][number], over: Partial<ComposePolicy> = {}): string[] {
  return composePolicyErrors(entry.config, {
    trusted: fx.orgs[entry.org].trusted,
    projectName: entry.project,
    ownDirs: [entry.appDir, entry.repoDir],
    ownPrefix: `${entry.app}-${entry.env}_`,
    allowBindMounts: false,
    allowDockerSocket: false,
    realpath: (p) => p,
    ...over,
  });
}

const app = (name: string) => fx.apps.find((a) => a.app === name)!;
const untrusted = { trusted: false };
const flagsOn = { trusted: false, allowBindMounts: true, allowDockerSocket: true };

describe("sample host compose (#886)", () => {
  it("covers the snapshot", () => {
    expect(fx.apps.length).toBeGreaterThan(60);
    expect(Object.values(fx.orgs).every((o) => o.trusted)).toBe(true);
  });

  it.each(fx.apps.map((a) => [`${a.app}/${a.env}`, a] as const))("%s deploys as its trusted org", (_name, entry) => {
    expect(refusals(entry)).toEqual([]);
  });

  it("would pass apps that stay inside themselves, untrusted", () => {
    const clean = fx.apps.filter((a) => refusals(a, untrusted).length === 0).map((a) => a.app);
    expect(clean).toEqual(
      expect.arrayContaining(["page-watch", "deploy-api", "whiteboard", "dev-tools", "ui-registry", "network-api", "uptime-monitor"]),
    );
  });

  it("passes build contexts inside the app's repo, untrusted", () => {
    for (const name of ["browser-api", "transcoder", "recorder", "screenshots"]) {
      expect(refusals(app(name), flagsOn).filter((e) => e.includes("builds from"))).toEqual([]);
    }
  });

  it("would refuse host access, untrusted", () => {
    expect(refusals(app("media-server"), flagsOn)).toContain('Service "media-server" uses network_mode "host"');
    expect(refusals(app("cadvisor"), flagsOn)).toContain('Service "cadvisor" mounts host path "/", which contains /etc');
    expect(refusals(app("torrent-client"), flagsOn)).toContain('Service "vpn-gateway" sets "devices"');
    expect(refusals(app("log-viewer"), untrusted)).toEqual([
      'Service "log-viewer" mounts the Docker socket, and the Docker socket is off for this project',
    ]);
    expect(refusals(app("log-viewer"), flagsOn)).toEqual([]);
  });

  it("would refuse joining Vardo's own networks and volumes, untrusted", () => {
    const vardo = fx.apps.find((a) => a.app === "vardo" && a.env === "production")!;
    expect(refusals(vardo, flagsOn)).toEqual(
      expect.arrayContaining([
        'Volume "traefik_dynamic" uses external volume "vardo_traefik_dynamic", which isn\'t this app\'s',
        'Network "internal" joins "vardo_internal", which isn\'t this app\'s',
      ]),
    );
  });

  it("would refuse vardo-network on services Vardo doesn't route, untrusted", () => {
    expect(refusals(app("documents"), flagsOn)).toContain(
      'Service "documents-db" joins vardo-network without being routed by Vardo',
    );
  });
});
