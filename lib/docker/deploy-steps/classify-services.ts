import type { ComposeFile } from "../compose-types";
import { isSharedService } from "../slot-partition";

/** Split services into build vs pull. Locally built images, x-vardo-shared services and `pull_policy: never` are never pulled. */
export function classifyComposeServices(
  services: ComposeFile["services"],
  builtImageRefs: string[] = [],
): { buildServices: string[]; pullServices: string[] } {
  const builtLocally = new Set(builtImageRefs);
  const buildServices = Object.entries(services)
    .filter(([, svc]) => svc.build)
    .map(([name]) => name);
  const pullServices = Object.entries(services)
    .filter(
      ([, svc]) =>
        svc.image && !svc.build && !builtLocally.has(svc.image) && !isSharedService(svc) && svc.pull_policy !== "never",
    )
    .map(([name]) => name);
  return { buildServices, pullServices };
}
