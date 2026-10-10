// The collectors' private network: created on demand and joined by the console.

import { existsSync } from "fs";
import { hostname } from "os";

import { connectToNetwork, ensureNetwork } from "@/lib/docker/client";
import { MONITORING_NETWORK } from "@/lib/docker/constants";
import type { ComposeFile } from "@/lib/docker/compose-types";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/** Whether this process runs in a container that can join a Docker network. */
function inContainer(): boolean {
  return !!process.env.CONTAINER_ID || existsSync("/.dockerenv");
}

/** Create the monitoring network and attach the console to it. Idempotent; logs, never throws. */
export async function ensureMonitoringNetwork(): Promise<void> {
  try {
    await ensureNetwork(MONITORING_NETWORK, { internal: true });
  } catch (err) {
    log.error(`Failed to create ${MONITORING_NETWORK}:`, err);
    return;
  }
  if (!inContainer()) return;
  try {
    if (await connectToNetwork(MONITORING_NETWORK, process.env.CONTAINER_ID ?? hostname())) log.info(`Joined ${MONITORING_NETWORK}`);
  } catch (err) {
    log.error(`Failed to join ${MONITORING_NETWORK}:`, err);
  }
}

/** Whether a compose joins the monitoring network. */
export function usesMonitoringNetwork(compose: Pick<ComposeFile, "networks">): boolean {
  return Object.entries(compose.networks ?? {}).some(([key, net]) => {
    const name = net && typeof net === "object" ? (net as { name?: unknown }).name : undefined;
    return (name ?? key) === MONITORING_NETWORK;
  });
}
