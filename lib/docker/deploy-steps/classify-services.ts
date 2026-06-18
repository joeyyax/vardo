import type { ComposeFile } from "../compose-types";

/**
 * Split compose services into those that build locally (have a `build:`
 * directive) and those whose image must be pulled from a registry.
 *
 * Build and pull are complementary, not exclusive: a compose file can mix
 * services that build locally (the user's own app) with services pulled from a
 * registry (sidecars like postgres, traefik). Pull only the services that have
 * no `build:` directive so we don't ask the registry for an image compose
 * intends to build.
 *
 * `builtImageRefs` lists images this deploy built locally (e.g.
 * `host/<app>:<sha>` from a Dockerfile/Nixpacks/Railpack build). They exist
 * only in the local daemon, referenced via `image:` with no `build:`, so they
 * must be excluded from the pull set — pulling them 404s and aborts the deploy.
 */
export function classifyComposeServices(
  services: ComposeFile["services"],
  builtImageRefs: string[] = [],
): { buildServices: string[]; pullServices: string[] } {
  const builtLocally = new Set(builtImageRefs);
  const buildServices = Object.entries(services)
    .filter(([, svc]) => svc.build)
    .map(([name]) => name);
  const pullServices = Object.entries(services)
    .filter(([, svc]) => svc.image && !svc.build && !builtLocally.has(svc.image))
    .map(([name]) => name);
  return { buildServices, pullServices };
}
