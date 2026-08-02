import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminAuth } from "@/lib/auth/admin";
import { refreshAuthMethods } from "@/lib/auth";
import { setSystemSetting, invalidateSettingsCache, getAuthMethodConfigLayers } from "@/lib/system-settings";
import {
  ALL_AUTH_METHODS,
  assertMethodsRemain,
  authMethodEnvVar,
  authMethodFromEnv,
  getAllAuthMethods,
  invalidateAuthMethodCache,
  type AuthMethod,
} from "@/lib/config/auth-methods";
import { withRateLimit } from "@/lib/api/with-rate-limit";

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const methods = await getAllAuthMethods();

  return NextResponse.json({ configured: true, methods });
}

async function handlePost(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();

  const parsed = z.record(z.string(), z.boolean()).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const known = new Set<string>(ALL_AUTH_METHODS);
  const unknown = Object.keys(parsed.data).filter((method) => !known.has(method));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown sign-in method: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }

  const changes = parsed.data as Partial<Record<AuthMethod, boolean>>;
  const layers = await getAuthMethodConfigLayers();

  // Refuse writes that wouldn't take effect — env vars and vardo.yml outrank
  // whatever we'd store here.
  const pinned: string[] = [];
  for (const method of Object.keys(changes) as AuthMethod[]) {
    if (authMethodFromEnv(method) !== undefined) {
      pinned.push(`${method} (pinned by ${authMethodEnvVar(method)})`);
    } else if (method in layers.config) {
      pinned.push(`${method} (pinned by vardo.yml)`);
    }
  }
  if (pinned.length > 0) {
    return NextResponse.json({ error: `Can't change ${pinned.join(", ")}.`, pinned }, { status: 409 });
  }

  const lockout = await assertMethodsRemain(changes);
  if (lockout) {
    return NextResponse.json({ error: lockout }, { status: 409 });
  }

  const merged: Record<string, boolean> = { ...layers.database, ...changes };
  await setSystemSetting("auth_methods", JSON.stringify(merged));

  invalidateSettingsCache("auth_methods");
  await invalidateAuthMethodCache();
  refreshAuthMethods();
  revalidatePath("/", "layout");

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-auth-methods" });
