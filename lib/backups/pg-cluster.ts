// Postgres server archives: roles plus every database, and a restore that swaps fresh copies into place.
// Each database restores into a scratch database first, so a failure leaves the live ones untouched.

import { spawn } from "child_process";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { PassThrough, type Readable } from "stream";
import { createGunzip } from "zlib";
import { nanoid } from "nanoid";
import { readEnv, type ContainerEnv } from "./dump-spec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { execFileAsync } from "@/lib/utils/exec";

/** First bytes of a server archive. Older archives are plain `pg_dump` SQL of one database. */
export const PG_CLUSTER_MAGIC = Buffer.from("VARDO-PGCLUSTER 1\n");

export type PgArchiveFormat = "cluster" | "sql";

/** Settings a scratch database is created with, read from `pg_database`. */
export type PgDatabaseInfo = {
  datname: string;
  owner: string;
  encoding_name: string;
  datcollate?: string | null;
  datctype?: string | null;
  datlocprovider?: string | null;
  datlocale?: string | null;
  daticulocale?: string | null;
  daticurules?: string | null;
  datconnlimit?: number | null;
};

type SectionHeader =
  | { section: "globals" }
  | { section: "properties"; database: string }
  | { section: "database"; database: PgDatabaseInfo }
  | { section: "end" };

/** Leftovers of an interrupted restore. Never dumped. */
const SCRATCH_NAME = /^vardo_(restore|old)_/;

const MAX_FRAME = 64 * 1024 * 1024;
const MAX_TEXT_SECTION = 64 * 1024 * 1024;

const DATABASE_INFO =
  "SELECT (to_jsonb(d) || jsonb_build_object('owner', pg_get_userbyid(d.datdba), 'encoding_name', pg_encoding_to_char(d.encoding)))::text " +
  "FROM pg_database d";
const LIST_DATABASES = `${DATABASE_INFO} WHERE NOT d.datistemplate AND d.datallowconn ORDER BY d.datname`;

// Database-level grants, settings and comment, which pg_dump writes only with --create. $1 user, $2 conninfo.
const PROPERTIES_SCRIPT = [
  "set -e",
  't=$(mktemp -d)',
  "trap 'rm -rf \"$t\"' EXIT",
  'pg_dump -U "$1" -Fc --create --schema-only --exclude-schema="*" -d "$2" > "$t/d"',
  'pg_restore --create -l "$t/d" | grep -E "^[0-9]+; [0-9]+ [0-9]+ (DATABASE PROPERTIES|ACL - DATABASE|COMMENT - DATABASE|SECURITY LABEL - DATABASE) " > "$t/l" || true',
  'pg_restore --create -L "$t/l" -f - "$t/d"',
].join("\n");

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A libpq conninfo naming one database, so a name with `=` is never parsed as options. */
export function conninfo(database: string): string {
  return `dbname='${database.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function postgresUser(env: ContainerEnv): string {
  return readEnv(env, "POSTGRES_USER") || "postgres";
}

/** `CREATE DATABASE` for a scratch copy with the source's encoding, locale and owner. */
export function buildCreateDatabase(name: string, info: PgDatabaseInfo | null): string {
  const parts = [`CREATE DATABASE ${quoteIdent(name)} WITH TEMPLATE = template0`];
  if (info) {
    parts.push(`OWNER = ${quoteIdent(info.owner)}`, `ENCODING = ${quoteLiteral(info.encoding_name)}`);
    if (info.datcollate) parts.push(`LC_COLLATE = ${quoteLiteral(info.datcollate)}`);
    if (info.datctype) parts.push(`LC_CTYPE = ${quoteLiteral(info.datctype)}`);
    const locale = info.datlocale ?? info.daticulocale ?? null;
    if (info.datlocprovider === "i") {
      parts.push("LOCALE_PROVIDER = icu");
      if (locale) parts.push(`ICU_LOCALE = ${quoteLiteral(locale)}`);
      if (info.daticurules) parts.push(`ICU_RULES = ${quoteLiteral(info.daticurules)}`);
    } else if (info.datlocprovider === "b") {
      parts.push("LOCALE_PROVIDER = builtin");
      if (locale) parts.push(`BUILTIN_LOCALE = ${quoteLiteral(locale)}`);
    } else if (info.datlocprovider === "c") {
      parts.push("LOCALE_PROVIDER = libc");
    }
    if (info.datconnlimit != null && info.datconnlimit !== -1) parts.push(`CONNECTION LIMIT = ${Number(info.datconnlimit)}`);
  }
  return `${parts.join(" ")};`;
}

function unquoteIdent(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}

/** Replay `pg_dumpall --globals-only` over a live server. The restoring user keeps its live password. */
export function prepareGlobals(sql: string, selfUser: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const create = line.match(/^CREATE ROLE ("(?:[^"]|"")+"|[^\s;"]+);$/);
      if (create && !line.includes("$vardo$")) {
        return `DO $vardo$ BEGIN ${line} EXCEPTION WHEN duplicate_object THEN NULL; END $vardo$;`;
      }
      const alter = line.match(/^ALTER ROLE ("(?:[^"]|"")+"|[^\s;"]+) WITH /);
      if (alter && unquoteIdent(alter[1]) === selfUser) return `-- Kept the live attributes of ${alter[1]}`;
      return line;
    })
    .join("\n");
}

/** `pg_restore --create` always writes the database's own CREATE first; keep what follows its `\connect`. */
function propertiesAfterCreate(sql: string): string {
  const i = sql.search(/^\\connect /m);
  return i < 0 ? "" : sql.slice(i);
}

/** Whether a gzipped dump is a server archive or a single database's SQL. */
export async function readPgArchiveFormat(archivePath: string): Promise<PgArchiveFormat> {
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  source.pipe(gunzip);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of gunzip) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= PG_CLUSTER_MAGIC.length) break;
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  const head = Buffer.concat(chunks).subarray(0, PG_CLUSTER_MAGIC.length);
  return head.equals(PG_CLUSTER_MAGIC) ? "cluster" : "sql";
}

const SQL_TOKEN = /"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_$]*|[^\sA-Za-z_]/g;
const NOT_A_ROLE = new Set(["public", "current_user", "session_user", "current_role", "none", "default"]);

/** A role name from a token: quoted names as written, bare names folded to lowercase. */
function roleName(token: string | undefined): string | null {
  if (!token) return null;
  let name: string;
  if (token.startsWith('"')) name = token.slice(1, -1).replace(/""/g, '"');
  else if (token.startsWith("'")) name = token.slice(1, -1).replace(/''/g, "'");
  else if (/^[A-Za-z_]/.test(token)) {
    if (NOT_A_ROLE.has(token.toLowerCase())) return null;
    name = token.toLowerCase();
  } else return null;
  return name && !name.startsWith("pg_") ? name : null;
}

/** Comma-separated role names starting at `i`. */
function roleList(tokens: string[], i: number, into: Set<string>): void {
  for (; i < tokens.length; i += 2) {
    const name = roleName(tokens[i]);
    if (name) into.add(name);
    if (tokens[i + 1] !== ",") return;
  }
}

/** Index of the last bare keyword `word`, or -1. */
function lastKeyword(upper: string[], word: string, before = upper.length): number {
  for (let i = before - 1; i >= 0; i--) if (upper[i] === word) return i;
  return -1;
}

/** Roles one line of pg_dump output names in `OWNER TO`, `GRANT`, `REVOKE`, `SET ROLE` and the like. */
export function rolesInStatement(line: string, into: Set<string>): void {
  if (!/^(ALTER|GRANT|REVOKE|SET|CREATE POLICY) /i.test(line)) return;
  const tokens = line.match(SQL_TOKEN) ?? [];
  const upper = tokens.map((t) => (/^[A-Za-z_]/.test(t) ? t.toUpperCase() : ""));

  if (upper[0] === "SET") {
    if (upper[1] === "ROLE") roleList(tokens, 2, into);
    else if (upper[1] === "SESSION" && upper[2] === "AUTHORIZATION") roleList(tokens, 3, into);
    return;
  }
  const owner = lastKeyword(upper, "OWNER");
  if (upper[0] === "ALTER" && owner >= 0 && upper[owner + 1] === "TO") roleList(tokens, owner + 2, into);
  if (upper[0] === "ALTER" && upper[1] === "DEFAULT" && upper[2] === "PRIVILEGES" && upper[3] === "FOR") {
    roleList(tokens, 5, into);
  }
  if (upper[0] === "CREATE") {
    const to = upper.indexOf("TO");
    if (to >= 0) roleList(tokens, to + 1, into);
    return;
  }

  const verb = upper.findIndex((u) => u === "GRANT" || u === "REVOKE");
  if (verb < 0) return;
  const grantedBy = lastKeyword(upper, "GRANTED");
  if (grantedBy >= 0 && upper[grantedBy + 1] === "BY") roleList(tokens, grantedBy + 2, into);
  const target = lastKeyword(upper, upper[verb] === "GRANT" ? "TO" : "FROM", grantedBy >= 0 ? grantedBy : upper.length);
  if (target < 0) return;
  roleList(tokens, target + 1, into);
  // A grant without ON grants role membership, so the granted names are roles too.
  if (upper.indexOf("ON", verb) < 0 || upper.indexOf("ON", verb) > target) {
    let i = verb + 1;
    if (upper[i] === "GRANT" && upper[i + 1] === "OPTION" && upper[i + 2] === "FOR") i += 3;
    if (upper[i] === "ADMIN" || upper[i] === "INHERIT" || upper[i] === "SET") i += 3;
    roleList(tokens, i, into);
  }
}

/** Roles a plain SQL dump names, skipping `COPY` data. */
export async function rolesInSql(lines: AsyncIterable<string>): Promise<Set<string>> {
  const roles = new Set<string>();
  let inCopy = false;
  for await (const line of lines) {
    if (inCopy) {
      if (line === "\\.") inCopy = false;
      continue;
    }
    if (/^COPY .* FROM stdin;$/.test(line)) inCopy = true;
    else rolesInStatement(line, roles);
  }
  return roles;
}

/** Roles a gzipped dump names. A custom-format dump is read through `pg_restore --schema-only`. */
async function rolesInDump(containerId: string, user: string, archivePath: string, format: "sql" | "pg-custom") {
  if (format === "sql") {
    const source = gunzipFile(archivePath);
    try {
      return await rolesInSql(createInterface({ input: source, crlfDelay: Infinity }));
    } finally {
      source.destroy();
    }
  }
  const sql = new PassThrough();
  const scanned = rolesInSql(createInterface({ input: sql, crlfDelay: Infinity }));
  const source = gunzipFile(archivePath);
  try {
    await streamInto(
      ["exec", "-i", containerId, "pg_restore", "-U", user, "--schema-only", "-f", "-"],
      source as AsyncIterable<Buffer>,
      "pg_restore --schema-only",
      (c) => sql.write(c),
    );
  } finally {
    source.destroy();
    sql.end();
  }
  return scanned;
}

/** Create, as `NOLOGIN`, every role a dump names that the server lacks, so owners and grants restore as dumped. */
export async function createMissingDumpRoles(opts: {
  containerId: string;
  containerEnv: ContainerEnv;
  archivePath: string;
  format: "sql" | "pg-custom";
  log: (msg: string) => void;
}): Promise<string[]> {
  const { containerId, archivePath, format, log } = opts;
  const user = postgresUser(opts.containerEnv);
  const named = [...(await rolesInDump(containerId, user, archivePath, format))];
  if (!named.length) return [];
  const out = await runPsql(
    containerId,
    user,
    `SELECT rolname FROM pg_roles WHERE rolname = ANY(ARRAY[${named.map(quoteLiteral).join(", ")}]::text[]);`,
  );
  const existing = new Set(out.split("\n").filter(Boolean));
  const missing = named.filter((n) => !existing.has(n)).sort();
  if (!missing.length) return [];
  await runPsql(containerId, user, missing.map((n) => `CREATE ROLE ${quoteIdent(n)} NOLOGIN;`).join("\n"));
  log(`Created role(s) the dump references but this server lacked, as NOLOGIN: ${missing.join(", ")}`);
  return missing;
}

/** Run SQL through psql in the container and return its unaligned output. */
async function runPsql(containerId: string, user: string, sql: string, database = "template1"): Promise<string> {
  const argv = [
    "exec", "-i", containerId,
    "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", conninfo(database),
  ];
  const chunks: Buffer[] = [];
  await streamInto(argv, [Buffer.from(sql)], "psql", (c) => chunks.push(c));
  return Buffer.concat(chunks).toString("utf8");
}

/** Feed `body` to a `docker exec -i` and wait for a clean exit. */
async function streamInto(
  argv: string[],
  body: AsyncIterable<Buffer> | Iterable<Buffer>,
  label: string,
  onStdout?: (chunk: Buffer) => void,
): Promise<void> {
  const child = spawn("docker", argv, { env: dockerEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr = (stderr + String(c)).slice(-8000);
  });
  child.stdout.on("data", (c: Buffer) => onStdout?.(c));
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code) => resolveExit(code ?? 1));
  });

  let stdinClosed = false;
  child.stdin.on("error", () => {
    stdinClosed = true;
  });
  child.stdin.on("close", () => {
    stdinClosed = true;
  });
  for await (const chunk of body) {
    if (stdinClosed) break;
    if (!child.stdin.write(chunk)) await drained(child.stdin);
  }
  child.stdin.end();

  const code = await exited;
  if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr.trim().slice(-500)}`);
}

function drained(stream: NodeJS.WritableStream & { destroyed?: boolean }): Promise<void> {
  return new Promise((resolveDrain) => {
    const done = () => {
      stream.removeListener("drain", done);
      stream.removeListener("close", done);
      resolveDrain();
    };
    stream.once("drain", done);
    stream.once("close", done);
  });
}

/** A process whose stdout is an archive. Same shape as the engine's producers. */
type PgClusterProducer = { stdout: Readable; done: Promise<void>; kill: () => void };

/** Stream a server archive: roles, then each database's settings and `pg_dump -Fc`. */
export function createPgClusterProducer(
  containerId: string,
  env: ContainerEnv,
  log: (msg: string) => void,
): PgClusterProducer {
  const user = postgresUser(env);
  const out = new PassThrough();
  let current: ReturnType<typeof spawn> | null = null;
  let killed = false;

  const write = async (buf: Buffer) => {
    if (out.destroyed) throw new Error("archive stream closed");
    if (!out.write(buf)) await drained(out);
  };

  const section = async (header: SectionHeader, argv: string[] | null) => {
    await write(Buffer.from(`${JSON.stringify(header)}\n`));
    if (argv) {
      if (killed) throw new Error("dump cancelled");
      const child = spawn("docker", argv, { env: dockerEnv(), stdio: ["ignore", "pipe", "pipe"] });
      current = child;
      let stderr = "";
      child.stderr!.on("data", (c) => {
        stderr = (stderr + String(c)).slice(-8000);
      });
      const exited = new Promise<number>((resolveExit, rejectExit) => {
        child.on("error", rejectExit);
        child.on("close", (code) => resolveExit(code ?? 1));
      });
      for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        await write(Buffer.concat([len, chunk]));
      }
      const code = await exited;
      current = null;
      if (code !== 0) throw new Error(`${argv[2]} exited ${code}: ${stderr.trim().slice(-500)}`);
    }
    await write(Buffer.alloc(4));
  };

  const done = (async () => {
    await write(PG_CLUSTER_MAGIC);
    const listing = await execFileAsync(
      "docker",
      ["exec", containerId, "psql", "-X", "-t", "-A", "-U", user, "-d", conninfo("template1"), "-c", LIST_DATABASES],
      { env: dockerEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const databases = String(listing.stdout)
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as PgDatabaseInfo)
      .filter((d) => {
        if (!SCRATCH_NAME.test(d.datname)) return true;
        log(`Skipping ${d.datname}, left behind by an interrupted restore`);
        return false;
      });
    log(`Dumping roles and ${databases.length} database(s): ${databases.map((d) => d.datname).join(", ")}`);

    await section({ section: "globals" }, ["exec", containerId, "pg_dumpall", "-U", user, "--globals-only"]);
    for (const d of databases) {
      await section(
        { section: "properties", database: d.datname },
        ["exec", containerId, "sh", "-c", PROPERTIES_SCRIPT, "sh", user, conninfo(d.datname)],
      );
      await section(
        { section: "database", database: d },
        ["exec", containerId, "pg_dump", "-U", user, "-Fc", "-d", conninfo(d.datname)],
      );
    }
    await section({ section: "end" }, null);
    out.end();
  })();
  done.catch((err) => out.destroy(err instanceof Error ? err : new Error(String(err))));

  return {
    stdout: out,
    done,
    kill: () => {
      killed = true;
      current?.kill();
    },
  };
}

class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    }
    return this.buf.length >= n;
  }

  async read(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new Error("The archive is truncated");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readLine(max: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      if (this.buf.length > max) throw new Error("The archive has a malformed section header");
      if (!(await this.fill(this.buf.length + 1))) throw new Error("The archive is truncated");
    }
  }

  async *frames(): AsyncGenerator<Buffer> {
    for (;;) {
      const len = (await this.read(4)).readUInt32BE(0);
      if (len === 0) return;
      if (len > MAX_FRAME) throw new Error("The archive has a malformed frame");
      yield Buffer.from(await this.read(len));
    }
  }

  async text(): Promise<string> {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const f of this.frames()) {
      total += f.length;
      if (total > MAX_TEXT_SECTION) throw new Error("The archive has an oversized text section");
      parts.push(f);
    }
    return Buffer.concat(parts).toString("utf8");
  }
}

function gunzipFile(archivePath: string): Readable {
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  source.on("error", (err) => gunzip.destroy(err));
  return source.pipe(gunzip);
}

type Staged = { name: string; scratch: string; properties: string | null };

class SwapError extends Error {}

/** Database settings, grants and comment as pg_dump writes them, read from the live server. */
async function liveProperties(containerId: string, user: string, database: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", containerId, "sh", "-c", PROPERTIES_SCRIPT, "sh", user, conninfo(database)],
    { env: dockerEnv(), timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return String(stdout);
}

async function liveDatabase(containerId: string, user: string, database: string): Promise<PgDatabaseInfo | null> {
  const out = await runPsql(
    containerId,
    user,
    `${DATABASE_INFO} WHERE d.datname = ${quoteLiteral(database)};`,
  );
  const line = out.split("\n").find((l) => l.trim());
  return line ? (JSON.parse(line) as PgDatabaseInfo) : null;
}

async function dropScratch(containerId: string, user: string, names: string[], log: (msg: string) => void) {
  for (const name of names) {
    try {
      await runPsql(containerId, user, `DROP DATABASE IF EXISTS ${quoteIdent(name)};`);
    } catch (err) {
      log(`WARNING: could not drop scratch database ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Swap every scratch copy in under its real name in one transaction, then drop the old copies. */
async function swapIntoPlace(containerId: string, user: string, staged: Staged[], token: string, log: (msg: string) => void) {
  const names = staged.map((s) => s.name);
  const existingOut = await runPsql(
    containerId,
    user,
    `SELECT datname FROM pg_database WHERE datname IN (${names.map(quoteLiteral).join(", ")});`,
  );
  const existing = new Set(existingOut.split("\n").filter(Boolean));
  const live = names.filter((n) => existing.has(n));
  const oldName = (i: number) => `vardo_old_${token}_${i}`;
  const liveList = `ARRAY[${live.map(quoteLiteral).join(", ") || "NULL"}]::text[]`;

  const fence = live.map((n) => `ALTER DATABASE ${quoteIdent(n)} ALLOW_CONNECTIONS false;`).join("\n");
  const unfence = live.map((n) => `ALTER DATABASE ${quoteIdent(n)} ALLOW_CONNECTIONS true;`).join("\n");
  const renames = staged
    .flatMap((s, i) => [
      ...(existing.has(s.name) ? [`ALTER DATABASE ${quoteIdent(s.name)} RENAME TO ${quoteIdent(oldName(i))};`] : []),
      `ALTER DATABASE ${quoteIdent(s.scratch)} RENAME TO ${quoteIdent(s.name)};`,
    ])
    .join("\n");

  if (live.length) log(`Closing connections to ${live.join(", ")}`);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await runPsql(
        containerId,
        user,
        [
          fence,
          `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ANY(${liveList}) AND pid <> pg_backend_pid();`,
          `DO $vardo$ BEGIN FOR i IN 1..100 LOOP EXIT WHEN NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname = ANY(${liveList}) AND pid <> pg_backend_pid()); PERFORM pg_sleep(0.1); END LOOP; END $vardo$;`,
          "BEGIN;",
          renames,
          "COMMIT;",
        ].join("\n"),
      );
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      log(`Swap attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (lastError) {
    if (unfence) await runPsql(containerId, user, unfence).catch(() => {});
    throw new SwapError(`Could not swap the restored databases into place: ${lastError instanceof Error ? lastError.message : lastError}`);
  }
  log(`Swapped in ${names.join(", ")}`);

  const settingsErrors: string[] = [];
  for (const s of staged) {
    const properties = propertiesAfterCreate(s.properties ?? "");
    if (!properties) continue;
    try {
      await runPsql(containerId, user, properties);
    } catch (err) {
      settingsErrors.push(`${s.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const [i, s] of staged.entries()) {
    if (!existing.has(s.name)) continue;
    try {
      await runPsql(containerId, user, `DROP DATABASE ${quoteIdent(oldName(i))};`);
    } catch (err) {
      log(`WARNING: the previous ${s.name} is kept as ${oldName(i)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (settingsErrors.length) {
    throw new Error(`The data was restored, but database settings or grants failed: ${settingsErrors.join("; ")}`);
  }
}

/** Restore a server archive's roles, then each database into a scratch copy. */
async function restoreCluster(
  containerId: string,
  user: string,
  archivePath: string,
  token: string,
  staged: Staged[],
  log: (msg: string) => void,
): Promise<void> {
  const source = gunzipFile(archivePath);
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  try {
    if (!(await reader.read(PG_CLUSTER_MAGIC.length)).equals(PG_CLUSTER_MAGIC)) {
      throw new Error("Not a Postgres server archive");
    }
    const properties = new Map<string, string>();
    for (;;) {
      const header = JSON.parse(await reader.readLine(1024 * 1024)) as SectionHeader;
      if (header.section === "end") return;

      if (header.section === "globals") {
        const sql = prepareGlobals(await reader.text(), user);
        log("Restoring roles");
        const atomic = !/^CREATE TABLESPACE /m.test(sql);
        await runPsql(containerId, user, atomic ? `BEGIN;\n${sql}\nCOMMIT;` : sql);
      } else if (header.section === "properties") {
        properties.set(header.database, await reader.text());
      } else if (header.section === "database") {
        const info = header.database;
        const scratch = `vardo_restore_${token}_${staged.length}`;
        log(`Restoring database ${info.datname} into ${scratch}`);
        await runPsql(containerId, user, buildCreateDatabase(scratch, info));
        staged.push({ name: info.datname, scratch, properties: properties.get(info.datname) ?? null });
        try {
          await streamInto(
            [
              "exec", "-i", containerId,
              "pg_restore", "-U", user, "-d", conninfo(scratch), "--single-transaction", "--exit-on-error",
            ],
            reader.frames(),
            "pg_restore",
          );
        } catch (err) {
          throw new Error(`Restoring database ${info.datname} failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        throw new Error("The archive has an unknown section");
      }
    }
  } finally {
    source.destroy();
  }
}

/** Restore an older archive: plain SQL of the image's own database. */
async function restoreSingle(
  containerId: string,
  env: ContainerEnv,
  archivePath: string,
  token: string,
  staged: Staged[],
  log: (msg: string) => void,
): Promise<void> {
  const user = postgresUser(env);
  const database = readEnv(env, "POSTGRES_DB") || user;
  const info = await liveDatabase(containerId, user, database);
  const properties = info ? await liveProperties(containerId, user, database) : null;
  await createMissingDumpRoles({ containerId, containerEnv: env, archivePath, format: "sql", log });
  const scratch = `vardo_restore_${token}_0`;
  log(`Restoring a single-database dump of ${database} into ${scratch}`);
  await runPsql(containerId, user, buildCreateDatabase(scratch, info));
  staged.push({ name: database, scratch, properties });
  const source = gunzipFile(archivePath);
  try {
    await streamInto(
      [
        "exec", "-i", containerId,
        "psql", "-X", "-q", "-U", user, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-d", conninfo(scratch),
      ],
      source as AsyncIterable<Buffer>,
      "psql",
    );
  } catch (err) {
    throw new Error(`Restoring database ${database} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    source.destroy();
  }
}

/** Restore a Postgres backup so each database matches the dump. Nothing live changes until all have restored. */
export async function restorePostgresArchive(opts: {
  containerId: string;
  containerEnv: ContainerEnv;
  archivePath: string;
  log: (msg: string) => void;
}): Promise<{ format: PgArchiveFormat; databases: string[] }> {
  const { containerId, containerEnv, archivePath, log } = opts;
  const user = postgresUser(containerEnv);
  const format = await readPgArchiveFormat(archivePath);
  const token = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const staged: Staged[] = [];
  log(format === "cluster" ? "Archive holds every database on the server" : "Archive holds one database (older format)");

  try {
    if (format === "cluster") await restoreCluster(containerId, user, archivePath, token, staged, log);
    else await restoreSingle(containerId, containerEnv, archivePath, token, staged, log);
  } catch (err) {
    await dropScratch(containerId, user, staged.map((s) => s.scratch), log);
    throw new Error(`${err instanceof Error ? err.message : err}. The live databases were not changed.`);
  }

  try {
    await swapIntoPlace(containerId, user, staged, token, log);
  } catch (err) {
    if (err instanceof SwapError) {
      await dropScratch(containerId, user, staged.map((s) => s.scratch), log);
      throw new Error(`${err.message}. The live databases were not changed.`);
    }
    throw err;
  }
  return { format, databases: staged.map((s) => s.name) };
}
