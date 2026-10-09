// External data import: load a pg_dump, mysqldump or volume tar into an app's database or volume.
// Files stream to disk and into the container; nothing holds a whole archive in memory.

import { spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, open, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip, createGzip } from "zlib";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, volumes } from "@/lib/db/schema";
import { withBulkWrite } from "@/lib/metrics/bulk-write";
import { assertSafeName } from "@/lib/docker/validate";
import { isSelfApp } from "@/lib/docker/self-env";
import { resolveDefaultEnv } from "@/lib/docker/resolve-env";
import { dockerEnv } from "@/lib/docker/docker-env";
import { execFileAsync } from "@/lib/utils/exec";
import { buildTarBackupScript, buildTarRestoreScript } from "./archive";
import { buildRestoreArgv, defaultDatabase } from "./dump-spec";
import type { DatabaseKind } from "./durability";
import { resolveDbContainer } from "./resolve-db-container";
import { createMissingDumpRoles, replacePostgresDatabase } from "./pg-cluster";
import {
  BACKUPS_DIR,
  resolveDockerVolume,
  restoreDumpWithSnapshot,
  restoreFilesWithSnapshot,
} from "./engine";

/** What a staged file turned out to be. */
export type ImportFormat = "pg-custom" | "sql" | "tar";

export type ImportSource =
  | { type: "upload"; stream: Readable }
  | { type: "url"; url: string }
  | { type: "ssh"; host: string; port?: number; username: string; path: string; privateKey?: string };

export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
  }
}

const GIB = 1024 ** 3;

function formatLimit(bytes: number): string {
  return bytes >= GIB ? `${Math.floor(bytes / GIB)} GiB` : `${Math.max(1, Math.floor(bytes / 1024 ** 2))} MiB`;
}

/** Upper bound on a source file, as received. `VARDO_IMPORT_MAX_BYTES` overrides 50 GiB. */
export function importMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.VARDO_IMPORT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 50 * GIB;
}

/** Format from the first bytes of the uncompressed stream. */
export function detectFormat(head: Buffer): ImportFormat {
  if (head.subarray(0, 5).toString("latin1") === "PGDMP") return "pg-custom";
  if (head.length >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  return "sql";
}

function isGzip(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/** Fails the pipeline once more than `max` bytes have passed. */
function byteLimit(max: number): Transform & { bytes: () => number } {
  let seen = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > max) {
        done(new ImportError(`The file is larger than the ${formatLimit(max)} import limit`, 413));
        return;
      }
      done(null, chunk);
    },
  }) as Transform & { bytes: () => number };
  t.bytes = () => seen;
  return t;
}

async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The first `n` bytes after gunzip. */
async function readGunzippedHead(path: string, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const gunzip = createGunzip();
  const source = createReadStream(path);
  source.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= n) break;
    }
  } catch (err) {
    throw new ImportError(`The file is not valid gzip: ${err instanceof Error ? err.message : err}`);
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  return Buffer.concat(chunks).subarray(0, n);
}

/**
 * Write a source to `dir/payload.gz`, gzipping it if it arrived plain, and name its format.
 * The limit applies to the bytes as received.
 */
export async function stageImport(
  input: Readable,
  dir: string,
  maxBytes: number = importMaxBytes(),
): Promise<{ path: string; format: ImportFormat; bytes: number }> {
  const raw = join(dir, "source");
  const limit = byteLimit(maxBytes);
  await pipeline(input, limit, createWriteStream(raw));
  if (limit.bytes() === 0) throw new ImportError("The file is empty");

  const path = join(dir, "payload.gz");
  const head = await readHead(raw, 512);
  let format: ImportFormat;
  if (isGzip(head)) {
    format = detectFormat(await readGunzippedHead(raw, 512));
    // Checked before anything stops: a truncated file would otherwise fail mid-restore.
    try {
      await execFileAsync("gzip", ["-t", raw], { timeout: 3_600_000 });
    } catch {
      throw new ImportError("The file is truncated or not valid gzip");
    }
    await rename(raw, path);
  } else {
    format = detectFormat(head);
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(path));
    await rm(raw, { force: true });
  }
  return { path, format, bytes: limit.bytes() };
}

const MYSQL_SYSTEM_SCHEMA = /^(USE `mysql`;|CREATE DATABASE[^\n]*`mysql`)/m;

/** Whether a gzipped SQL dump writes the server's own `mysql` schema, which holds its users. */
export async function writesMysqlSystemSchema(path: string): Promise<boolean> {
  let tail = "";
  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    const text = tail + (chunk as Buffer).toString("utf8");
    if (MYSQL_SYSTEM_SCHEMA.test(text)) return true;
    tail = text.slice(-256);
  }
  return false;
}

/** Stream a URL or SSH path. Uploads arrive as a stream already. */
export async function openSource(source: ImportSource): Promise<{ stream: Readable; cleanup: () => Promise<void> }> {
  if (source.type === "upload") return { stream: source.stream, cleanup: async () => {} };

  if (source.type === "url") {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new ImportError("The URL is not valid");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ImportError("Only http and https URLs can be fetched");
    }
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new ImportError(`Fetching the URL returned ${res.status}`);
    return {
      stream: Readable.fromWeb(res.body as import("stream/web").ReadableStream),
      cleanup: async () => {},
    };
  }

  const { host, username, path } = source;
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new ImportError("The SSH host or user is not valid");
  }
  if (!path.startsWith("/")) throw new ImportError("The SSH path must be absolute");

  const flags = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=30", "-o", "BatchMode=yes"];
  if (source.port && source.port !== 22) flags.push("-p", String(source.port));
  let keyFile: string | null = null;
  if (source.privateKey) {
    keyFile = join(BACKUPS_DIR, `.import-key-${nanoid(8)}`);
    await writeFile(keyFile, source.privateKey.endsWith("\n") ? source.privateKey : `${source.privateKey}\n`, { mode: 0o600 });
    flags.push("-i", keyFile);
  }

  // The remote shell parses the command, so the path goes in single quotes.
  const quoted = "'" + path.replace(/'/g, "'\\''") + "'";
  const child = spawn("ssh", [...flags, "--", `${username}@${host}`, `cat -- ${quoted}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    if (stderr.length < 4000) stderr += String(c);
  });
  const out = new Transform({
    transform(chunk, _enc, done) {
      done(null, chunk);
    },
    flush(done) {
      if (child.exitCode === null) {
        child.once("close", (code) =>
          done(code === 0 ? null : new ImportError(`ssh exited ${code}: ${stderr.trim().slice(0, 300)}`)),
        );
      } else {
        done(child.exitCode === 0 ? null : new ImportError(`ssh exited ${child.exitCode}: ${stderr.trim().slice(0, 300)}`));
      }
    },
  });
  child.on("error", (err) => out.destroy(err));
  child.stdout.pipe(out);
  return {
    stream: out,
    cleanup: async () => {
      if (child.exitCode === null) child.kill();
      if (keyFile) await rm(keyFile, { force: true });
    },
  };
}

type Staged = { path: string; format: ImportFormat };

/** Load a staged dump into a running database container. Same safety as a backup restore. */
export async function loadIntoDatabase(opts: {
  kind: DatabaseKind;
  containerId: string;
  containerEnv: string[];
  staged: Staged;
  database?: string;
  tmpDir: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { kind, containerId, containerEnv, staged, tmpDir, log } = opts;
  const database = opts.database || defaultDatabase(kind, containerEnv) || undefined;

  let restoreArgv: string[] = [];
  if (kind === "postgres") {
    if (staged.format === "sql") {
      restoreArgv = buildRestoreArgv(kind, containerId, containerEnv, database);
    } else if (staged.format !== "pg-custom") {
      throw new ImportError("A tar archive goes into a volume, not a database");
    }
  } else if (kind === "mysql" || kind === "mariadb") {
    if (staged.format !== "sql") throw new ImportError(`A ${kind} database takes a SQL dump`);
    if (await writesMysqlSystemSchema(staged.path)) {
      throw new ImportError(
        "The dump rewrites the server's mysql schema, which would replace this app's database users. Dump the app's database alone (mysqldump --databases <name>).",
      );
    }
    restoreArgv = buildRestoreArgv(kind, containerId, containerEnv, database);
  } else {
    throw new ImportError(`Importing into a ${kind} database isn't supported; import a volume tar instead`);
  }

  log(`Loading ${staged.format === "pg-custom" ? "a pg_dump archive" : "a SQL dump"} into ${kind}${database ? ` database "${database}"` : ""}`);
  if (kind === "postgres" && (staged.format === "sql" || staged.format === "pg-custom")) {
    await createMissingDumpRoles({ containerId, containerEnv, archivePath: staged.path, format: staged.format, log });
  }
  if (kind === "postgres" && staged.format === "pg-custom") {
    await replacePostgresDatabase({ containerId, containerEnv, archivePath: staged.path, database: database!, log });
    return;
  }
  await restoreDumpWithSnapshot({
    backupId: `import-${nanoid(6)}`,
    kind,
    containerId,
    containerEnv,
    archivePath: staged.path,
    tmpDir,
    log,
    restoreArgv,
  });
}

/** Replace a Docker volume's contents with a staged tar. Writers stop; the old contents come back on failure. */
export async function loadIntoVolume(opts: {
  dockerVolume: string;
  staged: Staged;
  tmpDir: string;
  quiesce: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const { dockerVolume, staged, tmpDir, log } = opts;
  if (staged.format !== "tar") throw new ImportError("A volume takes a tar or tar.gz archive");
  assertSafeName(dockerVolume);
  await rename(staged.path, join(tmpDir, "volume.tar.gz"));
  log(`Loading the archive into volume ${dockerVolume}`);
  await restoreFilesWithSnapshot({
    backupId: `import-${nanoid(6)}`,
    dest: opts.quiesce ? { kind: "volume", name: dockerVolume } : null,
    mount: `${dockerVolume}:/data`,
    snapshotScript: buildTarBackupScript(),
    restoreScript: buildTarRestoreScript(),
    tmpDir,
    timeoutMs: 4 * 3_600_000,
    log,
  });
}

/** Import a source into one of an app's volumes, or the database that volume holds. */
async function importIntoAppUnmarked(opts: {
  appId: string;
  organizationId: string;
  volumeName: string;
  database?: string;
  source: ImportSource;
  maxBytes?: number;
}): Promise<{ success: boolean; format: ImportFormat | null; bytes: number; log: string }> {
  const lines: string[] = [];
  const log = (msg: string) => {
    lines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, opts.appId), eq(apps.organizationId, opts.organizationId)),
    columns: { id: true, name: true },
  });
  if (!app) throw new ImportError("App not found", 404);
  if (isSelfApp(app.name)) throw new ImportError("Vardo's own data restores from a backup, not an import", 409);
  assertSafeName(opts.volumeName);
  if (opts.database !== undefined && !/^[A-Za-z0-9_$-]{1,64}$/.test(opts.database)) {
    throw new ImportError("The database name is not valid");
  }

  const vol = await db.query.volumes.findFirst({
    where: and(eq(volumes.appId, app.id), eq(volumes.name, opts.volumeName)),
  });
  if (vol?.type === "bind") throw new ImportError("Importing into a bind mount isn't supported", 409);

  const tmpDir = join(BACKUPS_DIR, `.tmp-import-${nanoid(8)}`);
  await mkdir(tmpDir, { recursive: true });

  let format: ImportFormat | null = null;
  let bytes = 0;
  const { stream, cleanup } = await openSource(opts.source);
  try {
    log(`Receiving ${opts.source.type === "upload" ? "the upload" : opts.source.type === "url" ? "the URL" : `${opts.source.host}:${opts.source.path}`}`);
    const staged = await stageImport(stream, tmpDir, opts.maxBytes);
    format = staged.format;
    bytes = staged.bytes;
    log(`Received ${bytes} bytes (${format})`);

    if (format === "tar") {
      let dockerVolume = await resolveDockerVolume(app.id, app.name, opts.volumeName, vol?.mountPath ?? null, log);
      if (!dockerVolume) {
        const env = await resolveDefaultEnv(app.id);
        dockerVolume = `${app.name}-${env.name}_${opts.volumeName}`;
        assertSafeName(dockerVolume);
        log(`Creating volume ${dockerVolume}`);
        await execFileAsync("docker", ["volume", "create", dockerVolume], { env: dockerEnv(), timeout: 10_000 });
      }
      await loadIntoVolume({ dockerVolume, staged, tmpDir, quiesce: true, log });
    } else {
      const spec = vol?.backupSpec;
      if (!spec) {
        throw new ImportError(
          `${opts.volumeName} isn't a recognized database volume. Deploy the app first, or import a volume tar`,
          409,
        );
      }
      const env = await resolveDefaultEnv(app.id);
      const container = await resolveDbContainer(spec, { id: app.id, name: app.name }, env?.name, log);
      if (!container) throw new ImportError(`No running container for service "${spec.service}" — start the app first`, 409);
      await loadIntoDatabase({
        kind: spec.kind,
        containerId: container.id,
        containerEnv: container.env,
        staged,
        database: opts.database,
        tmpDir,
        log,
      });
    }
    log("Import complete");
    return { success: true, format, bytes, log: lines.join("\n") };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    log(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, format, bytes, log: lines.join("\n") };
  } finally {
    await cleanup().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function importIntoApp(
  opts: Parameters<typeof importIntoAppUnmarked>[0],
): ReturnType<typeof importIntoAppUnmarked> {
  const result = await withBulkWrite(opts.appId, () => importIntoAppUnmarked(opts));
  if (result.success) {
    await import("./initial-backup")
      .then(({ armInitialBackupQuietly }) => armInitialBackupQuietly(opts.appId, "import"))
      .catch(() => {});
  }
  return result;
}
