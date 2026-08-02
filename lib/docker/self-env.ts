import { copyFile, access } from "fs/promises";
import { join } from "path";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";

/** The self-app is the only app whose env lives on the host, not in the database. */
export function isSelfApp(appName: string): boolean {
  return appName === VARDO_SELF_APP_NAME;
}

/**
 * Give the new slot the `.env` the running instance was started with.
 *
 * Vardo's own secrets stay on the host rather than in its database, so
 * `app.envContent` is empty and the normal write is skipped. Compose then
 * silently falls back to the `:-` defaults in the compose file — `VARDO_DOMAIN`
 * becomes `localhost` and the deploy produces a frontend nothing can reach.
 *
 * Returns the path copied from, or null when there was nothing to copy.
 */
export async function seedSelfEnv(
  appName: string,
  appDir: string,
  slotDir: string,
  activeSlot: string | null,
): Promise<string | null> {
  if (!isSelfApp(appName)) return null;

  const target = join(slotDir, ".env");
  const candidates = [
    join(appDir, "current", ".env"),
    ...(activeSlot ? [join(appDir, activeSlot, ".env")] : []),
    // Pre-migration layout, still live until the first engine deploy.
    join(appDir, "..", "env", "current", ".env"),
  ];

  for (const source of candidates) {
    try {
      await access(source);
    } catch {
      continue;
    }
    await copyFile(source, target);
    return source;
  }
  return null;
}
