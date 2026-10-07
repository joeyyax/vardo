import type { ContainerDetail } from "./discover";

/** Container port: Traefik label, then first exposed port, then user-supplied, then null. */
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
