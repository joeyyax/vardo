import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => false }));

const { parseAndSanitize } = await import("@/lib/docker/deploy-steps/prepare-repo");
const { DeployBlockedError } = await import("@/lib/docker/errors");

const log = () => {};
const svc = (extra: string) => `services:\n  web:\n    image: nginx\n${extra}`;

const HOST_ACCESS = {
  privileged: "    privileged: true\n",
  cap_add: "    cap_add:\n      - SYS_ADMIN\n",
  devices: "    devices:\n      - /dev/sda:/dev/sda\n",
  security_opt: "    security_opt:\n      - apparmor:unconfined\n",
  "network_mode: host": "    network_mode: host\n",
};

describe("deploy refuses host access for untrusted orgs", () => {
  for (const [key, yaml] of Object.entries(HOST_ACCESS)) {
    it(`blocks ${key}`, () => {
      expect(() => parseAndSanitize(svc(yaml), log, { orgTrusted: false })).toThrow(DeployBlockedError);
      expect(() => parseAndSanitize(svc(yaml), log, { orgTrusted: false })).toThrow(key.split(":")[0]);
    });
  }

  it("blocks them even with the project's mount flags on", () => {
    const opts = { orgTrusted: false, allowBindMounts: true, allowDockerSocket: true };
    expect(() => parseAndSanitize(svc(HOST_ACCESS.privileged), log, opts)).toThrow(DeployBlockedError);
  });

  it("lets a trusted org keep them", () => {
    const all = Object.values(HOST_ACCESS).filter((y) => !y.includes("network_mode")).join("");
    const compose = parseAndSanitize(svc(all), log, { orgTrusted: true });
    expect(compose.services.web.privileged).toBe(true);
    expect(compose.services.web.devices).toEqual(["/dev/sda:/dev/sda"]);
  });

  it("leaves ordinary compose alone", () => {
    expect(() => parseAndSanitize(svc("    cap_drop:\n      - ALL\n"), log, { orgTrusted: false })).not.toThrow();
  });
});
