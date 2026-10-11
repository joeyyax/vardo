// Abuse reporters by id. Only AbuseIPDB so far; CrowdSec and others implement AbuseReporter.

import { createAbuseIpdbReporter } from "./abuseipdb";
import type { AbuseReporter } from "./types";

const reporters = new Map<string, AbuseReporter>([["abuseipdb", createAbuseIpdbReporter()]]);

export const DEFAULT_REPORTER = "abuseipdb";

export function getReporter(id: string = DEFAULT_REPORTER): AbuseReporter | null {
  return reporters.get(id) ?? null;
}

export function listReporters(): AbuseReporter[] {
  return [...reporters.values()];
}
