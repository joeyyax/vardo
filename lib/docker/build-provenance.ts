// Labels and annotations that record who asked for a build on a target: this instance, the app and the commit.

import { getInstanceId } from "@/lib/constants";
import { getInstanceDisplayName } from "@/lib/system-settings";

export const REQUESTER_LABEL = "dev.vardo.build.requester";
export const REQUESTER_ID_LABEL = "dev.vardo.build.requester-id";
export const APP_LABEL = "dev.vardo.build.app";
export const REVISION_LABEL = "org.opencontainers.image.revision";

/** Characters a label value keeps; the rest would break a buildx `--output` or `--set` value. */
function clean(value: string): string {
  return value.replace(/[^A-Za-z0-9._:@/+-]/g, "-").slice(0, 200);
}

export type Provenance = Record<string, string>;

/** Provenance for `app` at `gitSha`, built at this instance's request. Fields it doesn't know are left out. */
export function provenanceLabels(p: { requester?: string | null; requesterId?: string | null; app?: string | null; gitSha?: string | null }): Provenance {
  const out: Provenance = {};
  if (p.requester) out[REQUESTER_LABEL] = clean(p.requester);
  if (p.requesterId) out[REQUESTER_ID_LABEL] = clean(p.requesterId);
  if (p.app) out[APP_LABEL] = clean(p.app);
  if (p.gitSha) out[REVISION_LABEL] = clean(p.gitSha);
  return out;
}

/** This instance's provenance for a build of `app` at `gitSha`. */
export async function buildProvenance(app: string | null | undefined, gitSha: string | null | undefined): Promise<Provenance> {
  const [requesterId, requester] = await Promise.all([getInstanceId().catch(() => null), getInstanceDisplayName().catch(() => null)]);
  return provenanceLabels({ requester, requesterId, app, gitSha });
}

/** `--set` flags that label every service in a bake. */
export function bakeLabelArgs(services: string[], labels: Provenance): string[] {
  return services.flatMap((s) => Object.entries(labels).flatMap(([k, v]) => ["--set", `${s}.labels.${k}=${v}`]));
}
