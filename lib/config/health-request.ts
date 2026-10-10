import nextPkg from "next/package.json";
import { isAppAdmin } from "@/lib/auth/admin";
import type { HealthRequestContext } from "./health";

/** Health reads from a signed-in request: logs links for admins and Next's version. */
export const requestHealthContext: HealthRequestContext = { isAdmin: isAppAdmin, nextVersion: nextPkg.version };
