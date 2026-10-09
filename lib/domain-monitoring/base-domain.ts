import { getInstanceConfig } from "@/lib/system-settings";
import { pickBaseDomain } from "./auto-domain";

/** The instance base domain from the admin settings, then `VARDO_BASE_DOMAIN`. */
export async function getInstanceBaseDomain(): Promise<string> {
  return pickBaseDomain(null, (await getInstanceConfig()).baseDomain);
}

export async function getBaseDomain(orgBaseDomain?: string | null): Promise<string> {
  if (orgBaseDomain) return orgBaseDomain;
  return getInstanceBaseDomain();
}
