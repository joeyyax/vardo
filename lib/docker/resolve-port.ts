import type { ContainerDetail } from "./discover";

/**
 * Resolve the container port using the priority chain:
 *   Traefik label → first exposed internal port → user-supplied → null
 *
 * The Traefik label port is the most specific — it is what Traefik is already
 * routing to. The first exposed port is a reasonable fallback when no label
 * exists. The user-supplied value is the last resort for containers with no
 * detectable port at all.
 */
export function resolveContainerPort(
  detail: Pick<ContainerDetail, "containerPort" | "ports">,
  userSupplied?: number,
): number | null {
  return (
    detail.containerPort ??
    detail.ports.find((p) => p.internal)?.internal ??
    userSupplied ??
    null
  );
}
