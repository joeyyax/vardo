import { can, type Capability } from "@/lib/auth/permissions";

type Access = { membership?: { role?: string } } | null | undefined;

/** Wraps a verifyOrgAccess mock so it denies a role the capability map denies. */
export function gateOrgAccess<T extends Access>(
  inner: (orgId: string, cap: Capability) => T | Promise<T>,
) {
  return async (orgId: string, cap: Capability) => {
    const access = await inner(orgId, cap);
    return access && can(access.membership?.role, cap) ? access : null;
  };
}
