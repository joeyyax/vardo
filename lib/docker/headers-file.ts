// Each app's security headers middleware as a Traefik file-provider file, so saved settings apply without a redeploy.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import {
  headersLabelOptions,
  headersMiddlewareName,
  headersMiddlewareOptions,
  headersMiddlewareRef,
  type SecurityHeaderConfig,
} from "@/lib/security/response-headers";
import type { HeadersMiddleware } from "./compose-types";

// .yaml so no app's <name>.yml can replace it.
const FILE_PREFIX = "vardo-headers-";
const FILE_SUFFIX = ".yaml";
const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function headersFileName(appId: string): string {
  if (!APP_ID_RE.test(appId)) throw new Error(`Refusing headers file for app id "${appId.slice(0, 80)}"`);
  return `${FILE_PREFIX}${appId}${FILE_SUFFIX}`;
}

/** The middleware definition. With every header off it's an empty chain, since Traefik refuses an empty headers block. */
export function renderHeadersMiddleware(appId: string, config: SecurityHeaderConfig): Record<string, unknown> {
  const options = headersMiddlewareOptions(config);
  const middleware = Object.keys(options).length > 0 ? { headers: options } : { chain: { middlewares: [] } };
  return { http: { middlewares: { [headersMiddlewareName(appId)]: middleware } } };
}

export function renderHeadersFile(appId: string, config: SecurityHeaderConfig): string {
  return `# Written by Vardo from the app's security header settings. Do not edit.\n${YAML.stringify(renderHeadersMiddleware(appId, config))}`;
}

/** Whether a rendered file defines exactly the app's middleware. A bad file stops Traefik loading every file. */
export function isValidHeadersFile(content: string, appId: string): boolean {
  try {
    const parsed = YAML.parse(content) as { http?: { middlewares?: Record<string, Record<string, unknown>> } };
    const middlewares = parsed?.http?.middlewares;
    if (!middlewares || Object.keys(parsed).length !== 1 || Object.keys(parsed.http!).length !== 1) return false;
    const names = Object.keys(middlewares);
    if (names.length !== 1 || names[0] !== headersMiddlewareName(appId)) return false;
    const def = middlewares[names[0]];
    const kinds = Object.keys(def ?? {});
    if (kinds.length !== 1) return false;
    if (kinds[0] === "chain") return Array.isArray((def.chain as { middlewares?: unknown })?.middlewares);
    if (kinds[0] !== "headers") return false;
    const headers = def.headers as Record<string, unknown>;
    return Object.keys(headers).length > 0 && Object.values(headers).every((v) => v !== "" && v !== null && v !== undefined);
  } catch {
    return false;
  }
}

function isMissingVolume(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EROFS";
}

/** Writes the app's middleware for Traefik to reload. "skipped" where there's no Traefik volume. */
export async function writeAppHeadersFile(
  appId: string,
  config: SecurityHeaderConfig,
  dir: string = TRAEFIK_DYNAMIC_DIR,
): Promise<"written" | "unchanged" | "skipped"> {
  const path = join(dir, headersFileName(appId));
  const content = renderHeadersFile(appId, config);
  if (!isValidHeadersFile(content, appId)) throw new Error(`Rendered headers middleware for ${appId} did not validate`);
  try {
    if ((await readFile(path, "utf-8").catch(() => null)) === content) return "unchanged";
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.tmp`, content, { encoding: "utf-8", mode: 0o644 });
    await rename(`${path}.tmp`, path);
    return "written";
  } catch (err) {
    if (isMissingVolume(err)) return "skipped";
    throw err;
  }
}

export async function removeAppHeadersFile(appId: string, dir: string = TRAEFIK_DYNAMIC_DIR): Promise<void> {
  try {
    await unlink(join(dir, headersFileName(appId)));
  } catch (err) {
    if (!isMissingVolume(err)) throw err;
  }
}

/** App ids that have a headers file in the directory. */
export async function listHeadersFileAppIds(dir: string = TRAEFIK_DYNAMIC_DIR): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))
      .map((n) => n.slice(FILE_PREFIX.length, -FILE_SUFFIX.length))
      .filter((id) => APP_ID_RE.test(id));
  } catch (err) {
    if (isMissingVolume(err)) return [];
    throw err;
  }
}

/** What a deploy's routers reference: the file once it's written, else the same headers as labels. */
export async function deployHeadersMiddleware(
  appId: string,
  config: SecurityHeaderConfig,
  dir: string = TRAEFIK_DYNAMIC_DIR,
): Promise<{ headers: HeadersMiddleware | null; live: boolean; error?: string }> {
  let outcome: "written" | "unchanged" | "skipped";
  let error: string | undefined;
  try {
    outcome = await writeAppHeadersFile(appId, config, dir);
  } catch (err) {
    outcome = "skipped";
    error = err instanceof Error ? err.message : String(err);
  }
  if (outcome !== "skipped") return { headers: { ref: headersMiddlewareRef(appId) }, live: true };
  const options = headersLabelOptions(config);
  return { headers: Object.keys(options).length > 0 ? { options } : null, live: false, error };
}

/** Writes every listed app's file and removes files for apps that no longer exist. */
export async function reconcileHeadersFiles(
  apps: { id: string; config: SecurityHeaderConfig }[],
  dir: string = TRAEFIK_DYNAMIC_DIR,
): Promise<{ written: number; removed: number }> {
  let written = 0;
  for (const app of apps) {
    if ((await writeAppHeadersFile(app.id, app.config, dir)) === "written") written++;
  }
  const keep = new Set(apps.map((a) => a.id));
  let removed = 0;
  for (const id of await listHeadersFileAppIds(dir)) {
    if (keep.has(id)) continue;
    await removeAppHeadersFile(id, dir);
    removed++;
  }
  return { written, removed };
}
