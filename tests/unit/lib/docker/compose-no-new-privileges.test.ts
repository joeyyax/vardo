import { describe, expect, it } from "vitest";
import { buildVardoOverlay } from "@/lib/docker/compose-inject";
import { parseCompose } from "@/lib/docker/compose-parse";
import { hostAccessErrors } from "@/lib/docker/compose-validate";
import { composePolicyErrors } from "@/lib/docker/compose-policy";

const overlayFor = (yaml: string, orgTrusted: boolean) =>
  buildVardoOverlay({ fullCompose: parseCompose(yaml), networkName: "vardo-network", orgTrusted, hostCpus: 4 });

const TWO = "services:\n  web:\n    image: nginx\n  worker:\n    image: worker\n";

describe("no-new-privileges (#889)", () => {
  it("sets it on every service of an untrusted org", () => {
    const overlay = overlayFor(TWO, false);
    expect(overlay.services.web.security_opt).toEqual(["no-new-privileges:true"]);
    expect(overlay.services.worker.security_opt).toEqual(["no-new-privileges:true"]);
  });

  it("leaves a trusted org's services alone", () => {
    const overlay = overlayFor(TWO, true);
    expect(overlay.services.web.security_opt).toBeUndefined();
  });

  it("doesn't repeat a compose that already sets it", () => {
    const overlay = overlayFor("services:\n  web:\n    image: nginx\n    security_opt: [\"no-new-privileges:true\"]\n", false);
    expect(overlay.services.web.security_opt).toBeUndefined();
  });

  it("lets an untrusted compose set it, and nothing else", () => {
    const ok = parseCompose("services:\n  web:\n    image: nginx\n    security_opt: [\"no-new-privileges:true\"]\n");
    expect(hostAccessErrors(ok)).toEqual([]);
    const bad = parseCompose("services:\n  web:\n    image: nginx\n    security_opt: [\"no-new-privileges:true\", \"seccomp=unconfined\"]\n");
    expect(hostAccessErrors(bad)).toHaveLength(1);
  });

  it("passes the untrusted policy with the resolved setting", () => {
    const config = { services: { web: { image: "nginx", security_opt: ["no-new-privileges:true"] } } };
    const errors = composePolicyErrors(config, {
      trusted: false, projectName: "web-production-blue", ownDirs: ["/opt/vardo/apps/web/production"],
      ownPrefix: "web-production_", allowBindMounts: false, allowDockerSocket: false, realpath: (p) => p,
    });
    expect(errors).toEqual([]);
  });
});
