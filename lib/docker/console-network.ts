// Keeps the console off vardo-network and on a network only Traefik shares, so an app can't reach it past the console lock (#1136).

import { hostname } from "os";

import { dockerRequest, ensureNetwork } from "@/lib/docker/client";
import { CONSOLE_NETWORK, NETWORK_NAME } from "@/lib/docker/constants";
import { findTraefikContainer } from "@/lib/docker/traefik-api";
import { inContainer } from "@/lib/infra/monitoring-network";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("console-network");

/** The label that tells Traefik which of a container's networks to reach it on. */
export const TRAEFIK_NETWORK_LABEL = "traefik.docker.network";

export type ContainerView = {
  Id: string;
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
};

export type IsolationStep = "join-console" | "attach-traefik" | "leave-vardo-network";

export type IsolationPlan = { steps: IsolationStep[]; skipped?: string };

function networksOf(c: ContainerView): Set<string> {
  return new Set(Object.keys(c.NetworkSettings?.Networks ?? {}));
}

export type IsolationNetworks = { console: string; apps: string };

const NETWORKS: IsolationNetworks = { console: CONSOLE_NETWORK, apps: NETWORK_NAME };

/** Steps left, in order: the console on its network, Traefik beside it, then the console off vardo-network. */
export function planIsolation(
  self: ContainerView | null,
  traefik: ContainerView | null,
  nets: IsolationNetworks = NETWORKS,
): IsolationPlan {
  if (!self) return { steps: [], skipped: "not in a container" };
  const routedOn = self.Config?.Labels?.[TRAEFIK_NETWORK_LABEL];
  if (routedOn !== nets.console) return { steps: [], skipped: `Traefik reaches this console on ${routedOn || "its default network"}` };
  if (!traefik) return { steps: [], skipped: "no Traefik container" };

  const steps: IsolationStep[] = [];
  if (!networksOf(self).has(nets.console)) steps.push("join-console");
  if (!networksOf(traefik).has(nets.console)) steps.push("attach-traefik");
  if (networksOf(self).has(nets.apps)) steps.push("leave-vardo-network");
  return { steps };
}

export type IsolationDeps = {
  inspect: (container: string) => Promise<ContainerView | null>;
  traefik: () => Promise<string | null>;
  ensureNetwork: (name: string) => Promise<void>;
  connect: (network: string, container: string) => Promise<void>;
  disconnect: (network: string, container: string) => Promise<void>;
  self: () => string | null;
  networks?: IsolationNetworks;
};

async function inspect(container: string): Promise<ContainerView | null> {
  try {
    return await dockerRequest<ContainerView>("GET", `/containers/${encodeURIComponent(container)}/json`);
  } catch (err) {
    if (/returned 404/.test(String(err))) return null;
    throw err;
  }
}

/** The Docker API behind isolateConsole. */
export const dockerIsolationDeps: IsolationDeps = {
  inspect,
  traefik: async () => (await findTraefikContainer())?.id ?? null,
  ensureNetwork: (name) => ensureNetwork(name),
  connect: async (network, container) => {
    await dockerRequest("POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: container });
  },
  disconnect: async (network, container) => {
    await dockerRequest("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: container });
  },
  self: () => (inContainer() ? process.env.CONTAINER_ID || hostname() : null),
};

/** Applies the plan. Stops at the first failure, so the console never leaves vardo-network before Traefik can reach it. */
export async function isolateConsole(deps: IsolationDeps = dockerIsolationDeps): Promise<IsolationPlan> {
  const nets = deps.networks ?? NETWORKS;
  const selfName = deps.self();
  const self = selfName ? await deps.inspect(selfName) : null;
  const traefikId = self ? await deps.traefik() : null;
  const traefik = traefikId ? await deps.inspect(traefikId) : null;
  const plan = planIsolation(self, traefik, nets);

  for (const step of plan.steps) {
    if (step === "join-console") {
      await deps.ensureNetwork(nets.console);
      await deps.connect(nets.console, self!.Id);
    } else if (step === "attach-traefik") {
      await deps.connect(nets.console, traefik!.Id);
    } else {
      await deps.disconnect(nets.apps, self!.Id);
    }
    log.info(`Console network: ${step}`);
  }
  return plan;
}

/** isolateConsole that logs instead of throwing. */
export async function isolateConsoleSafely(): Promise<void> {
  try {
    await isolateConsole();
  } catch (err) {
    log.warn("Couldn't isolate the console from vardo-network:", err instanceof Error ? err.message : err);
  }
}

/** Puts Traefik back beside the console after a recreate, and the console back off vardo-network. Per web process. */
export const consoleNetworkLoop = new IntervalLoop({
  name: "console-network",
  intervalMs: 30_000,
  firstRunMs: 30_000,
  log,
  run: () => isolateConsoleSafely(),
});

/** Whether this process's container is on a network; null outside a container or when Docker doesn't answer. */
export async function ownContainerOn(network: string): Promise<boolean | null> {
  const selfName = dockerIsolationDeps.self();
  if (!selfName) return null;
  try {
    const self = await inspect(selfName);
    return self ? networksOf(self).has(network) : null;
  } catch {
    return null;
  }
}
