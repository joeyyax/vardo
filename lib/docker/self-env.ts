import { copyFile } from "fs/promises";
import { dirname, join } from "path";
import { VARDO_SELF_APP_NAME } from "@/lib/api/system-managed";
import { APP_UID, DOCKER_CLEANUP_TIMEOUT } from "./constants";
import { execFileAsync } from "@/lib/utils/exec";

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
      await copyFile(source, target);
      return source;
    } catch (err) {
      if (!isAccessError(err)) continue;
      // The host `.env` is root-owned and mode 600; the app runs unprivileged.
      await copyAsRoot(source, target);
      return source;
    }
  }
  return null;
}

function isAccessError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return (err as { code: string }).code === "EACCES" || (err as { code: string }).code === "EPERM";
}

/** Copy through a throwaway container, then hand the copy to the app's uid. */
async function copyAsRoot(source: string, target: string): Promise<void> {
  await execFileAsync(
    "docker",
    [
      "run", "--rm",
      "-v", `${await realDir(source)}:/from:ro`,
      "-v", `${dirname(target)}:/to`,
      "alpine", "sh", "-c",
      `cp /from/.env /to/.env && chown ${APP_UID}:${APP_UID} /to/.env && chmod 600 /to/.env`,
    ],
    { timeout: DOCKER_CLEANUP_TIMEOUT },
  );
}

/** Bind mounts follow symlinks on the host, so resolve before mounting. */
async function realDir(source: string): Promise<string> {
  const { realpath } = await import("fs/promises");
  return dirname(await realpath(source));
}
