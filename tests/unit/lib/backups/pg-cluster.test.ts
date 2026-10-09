// Postgres server archives against real postgres:17 containers, plus the pure SQL builders.
// The container tests skip when Docker or the postgres:17 image isn't available locally. They never pull.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import {
  buildCreateDatabase,
  conninfo,
  createPgClusterProducer,
  PG_CLUSTER_MAGIC,
  prepareGlobals,
  readPgArchiveFormat,
  restorePostgresArchive,
  rolesInSql,
  rolesInStatement,
  schemaInHeader,
} from "@/lib/backups/pg-cluster";
import { drillPostgres } from "@/lib/backups/drill";
import { scratchDatabaseFor } from "@/lib/backups/drill-plan";
import { loadIntoDatabase } from "@/lib/backups/import";

const IMAGE = "postgres:17";
const ENV = ["POSTGRES_USER=app", "POSTGRES_DB=appdb", "POSTGRES_PASSWORD=pw"];

describe("prepareGlobals", () => {
  const dumped = [
    "CREATE ROLE app;",
    "ALTER ROLE app WITH SUPERUSER LOGIN PASSWORD 'SCRAM-old';",
    'CREATE ROLE "Mixed ""Case""";',
    'ALTER ROLE "Mixed ""Case""" WITH NOLOGIN;',
  ].join("\n");

  it("creates roles only when missing", () => {
    expect(prepareGlobals(dumped, "app")).toContain(
      'DO $vardo$ BEGIN CREATE ROLE "Mixed ""Case"""; EXCEPTION WHEN duplicate_object THEN NULL; END $vardo$;',
    );
  });

  it("keeps the restoring user's live password", () => {
    const out = prepareGlobals(dumped, "app");
    expect(out).not.toContain("SCRAM-old");
    expect(out).toContain('ALTER ROLE "Mixed ""Case""" WITH NOLOGIN;');
  });

  it("matches a quoted restoring user", () => {
    expect(prepareGlobals('ALTER ROLE "My App" WITH LOGIN;', "My App")).not.toContain("WITH LOGIN");
  });
});

describe("buildCreateDatabase", () => {
  it("copies encoding, locale and owner", () => {
    expect(
      buildCreateDatabase("tmp", {
        datname: "immich",
        owner: "postgres",
        encoding_name: "UTF8",
        datcollate: "C",
        datctype: "C",
        datlocprovider: "i",
        datlocale: "und-x-icu",
        datconnlimit: -1,
      }),
    ).toBe(
      `CREATE DATABASE "tmp" WITH TEMPLATE = template0 OWNER = "postgres" ENCODING = 'UTF8' LC_COLLATE = 'C' LC_CTYPE = 'C' LOCALE_PROVIDER = icu ICU_LOCALE = 'und-x-icu';`,
    );
  });

  it("quotes names and literals", () => {
    expect(buildCreateDatabase('a"b', { datname: "x", owner: "o'k", encoding_name: "UTF8" })).toBe(
      `CREATE DATABASE "a""b" WITH TEMPLATE = template0 OWNER = "o'k" ENCODING = 'UTF8';`,
    );
  });

  it("names a database in a conninfo string, so options can't ride along", () => {
    expect(conninfo("a' host=evil")).toBe("dbname='a\\' host=evil'");
  });
});

describe("rolesInStatement", () => {
  const roles = (...lines: string[]) => {
    const into = new Set<string>();
    for (const line of lines) rolesInStatement(line, into);
    return [...into].sort();
  };

  it("reads owners, grantees, revokees and session roles", () => {
    expect(
      roles(
        "ALTER TABLE app.notes OWNER TO owner_role;",
        'ALTER SCHEMA "Odd Schema" OWNER TO "Mixed ""Case""";',
        "GRANT SELECT ON TABLE app.notes TO reader, writer WITH GRANT OPTION;",
        "REVOKE ALL ON SCHEMA public FROM revoked CASCADE;",
        "SET SESSION AUTHORIZATION 'session_role';",
        "SET ROLE set_role;",
        "ALTER DEFAULT PRIVILEGES FOR ROLE definer IN SCHEMA app GRANT SELECT ON TABLES TO defaulted;",
        "CREATE POLICY p ON app.notes TO policy_role USING ((id > 0));",
        "GRANT member_of TO member GRANTED BY grantor;",
      ),
    ).toEqual(["Mixed \"Case\"", "defaulted", "definer", "grantor", "member", "member_of", "owner_role", "policy_role", "reader", "revoked", "session_role", "set_role", "writer"]);
  });

  it("skips PUBLIC, built-ins and keywords", () => {
    expect(
      roles(
        "GRANT USAGE ON SCHEMA public TO PUBLIC;",
        "GRANT pg_read_all_data TO pg_monitor;",
        "SET ROLE NONE;",
        "ALTER TABLE t OWNER TO CURRENT_USER;",
        "SET search_path = app, public;",
        "ALTER TABLE t ALTER COLUMN owner SET DEFAULT 'x';",
      ),
    ).toEqual([]);
  });

  it("ignores COPY data", async () => {
    async function* lines() {
      yield "COPY public.t (body) FROM stdin;";
      yield "GRANT ALL ON t TO from_data;";
      yield "\\.";
      yield "ALTER TABLE public.t OWNER TO real_owner;";
    }
    expect([...(await rolesInSql(lines()))]).toEqual(["real_owner"]);
  });

  it("collects the schemas a dump writes from its headers", async () => {
    async function* lines() {
      yield "-- Name: s2; Type: SCHEMA; Schema: -; Owner: app";
      yield "-- Name: ev; Type: TABLE; Schema: public; Owner: app";
      yield "-- Name: ev ev_pkey; Type: CONSTRAINT; Schema: public; Owner: app";
      yield "-- Name: plpgsql; Type: EXTENSION; Schema: -; Owner: -";
      yield "-- Name: x; Type: FUNCTION; Schema: pg_catalog; Owner: app";
    }
    const schemas = new Set<string>();
    await rolesInSql(lines(), schemas);
    expect([...schemas].sort()).toEqual(["public", "s2"]);
  });
});

describe("schemaInHeader", () => {
  it("reads the schema column, or the name of a schema entry", () => {
    expect(schemaInHeader("-- Data for Name: ev_2025; Type: TABLE DATA; Schema: public; Owner: app")).toBe("public");
    expect(schemaInHeader("-- Name: my; schema; Type: SCHEMA; Schema: -; Owner: app")).toBe("my; schema");
    expect(schemaInHeader("-- Name: t; Type: TABLE; Schema: pg_temp_3; Owner: app")).toBeNull();
    expect(schemaInHeader("-- PostgreSQL database dump")).toBeNull();
  });
});

function imagePresent(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const READY = imagePresent(IMAGE);
const PREFIX = `vardo-test-pg906-${process.pid}-${Date.now().toString(36)}`;
const containers: string[] = [];
const background: ChildProcess[] = [];

function startPostgres(suffix: string, image = IMAGE): string {
  const name = `${PREFIX}-${suffix}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--network", "none", ...ENV.flatMap((e) => ["-e", e]), image], {
    stdio: "ignore",
  });
  containers.push(name);
  return name;
}

async function waitReady(name: string) {
  for (let i = 0; i < 120; i++) {
    const logs = execFileSync("docker", ["logs", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (logs.includes("PostgreSQL init process complete")) {
      try {
        execFileSync("docker", ["exec", name, "pg_isready", "-U", "app", "-d", "appdb"], { stdio: "ignore" });
        return;
      } catch {
        // still starting
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} never became ready`);
}

function sql(name: string, database: string, script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", name, "psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-U", "app", "-d", database],
    { input: script, encoding: "utf8" },
  ).trim();
}

async function dumpCluster(name: string, file: string) {
  const producer = createPgClusterProducer(name, ENV, () => {});
  await Promise.all([pipeline(producer.stdout, createGzip(), createWriteStream(file)), producer.done]);
}

function databases(name: string): string[] {
  return sql(name, "postgres", "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1;").split("\n");
}

const SEED = `
CREATE ROLE owner_role;
CREATE ROLE reader;
CREATE EXTENSION citext;
CREATE EXTENSION pg_trgm;
CREATE SCHEMA app AUTHORIZATION owner_role;
CREATE TABLE app.notes (id serial PRIMARY KEY, body citext NOT NULL);
ALTER TABLE app.notes OWNER TO owner_role;
CREATE INDEX notes_trgm ON app.notes USING gin ((body::text) gin_trgm_ops);
INSERT INTO app.notes (body) VALUES ('alpha'), ('beta');
GRANT USAGE ON SCHEMA app TO reader;
GRANT SELECT ON app.notes TO reader;
CREATE TABLE public.kept (id int);
INSERT INTO public.kept VALUES (1);
ALTER DATABASE appdb SET search_path TO app, public;
REVOKE CONNECT ON DATABASE appdb FROM PUBLIC;
GRANT CONNECT ON DATABASE appdb TO reader;
CREATE DATABASE second OWNER owner_role;
`;

afterAll(() => {
  for (const child of background) child.kill();
  for (const name of containers) {
    try {
      execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
});

describe.skipIf(!READY)("Postgres server archives against real postgres:17", () => {
  let source: string;
  let target: string;
  let dir: string;
  let archive: string;
  let legacy: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vardo-pg906-"));
    archive = join(dir, "cluster.dump.gz");
    legacy = join(dir, "legacy.dump.gz");
    source = startPostgres("source");
    target = startPostgres("target");
    await Promise.all([waitReady(source), waitReady(target)]);

    sql(source, "appdb", SEED);
    sql(source, "second", "CREATE TABLE things (name text); INSERT INTO things VALUES ('one'), ('two'), ('three');");
    await dumpCluster(source, archive);
    // Exactly what Postgres backups wrote before server archives.
    writeFileSync(
      legacy,
      gzipSync(execFileSync("docker", ["exec", source, "pg_dump", "-U", "app", "--clean", "--if-exists", "appdb"])),
    );
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the server format and detects both formats", async () => {
    expect(gunzipSync(readFileSync(archive)).subarray(0, PG_CLUSTER_MAGIC.length).equals(PG_CLUSTER_MAGIC)).toBe(true);
    expect(await readPgArchiveFormat(archive)).toBe("cluster");
    expect(await readPgArchiveFormat(legacy)).toBe("sql");
  });

  it("leaves nothing the dump doesn't hold, even with a client connected", async () => {
    sql(
      source,
      "appdb",
      `CREATE TABLE public.extra (id int);
       CREATE VIEW public.extra_view AS SELECT 1 AS one;
       CREATE SEQUENCE public.extra_seq;
       CREATE FUNCTION public.extra_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
       CREATE TABLE app.extra_in_app (id int);
       CREATE EXTENSION hstore;
       DELETE FROM app.notes WHERE body = 'alpha';`,
    );
    sql(source, "second", "CREATE TABLE stray (id int); DELETE FROM things;");
    const client = spawn("docker", ["exec", source, "psql", "-U", "app", "-d", "appdb", "-c", "SELECT pg_sleep(120)"], {
      stdio: "ignore",
    });
    background.push(client);
    await new Promise((r) => setTimeout(r, 500));

    const result = await restorePostgresArchive({ containerId: source, containerEnv: ENV, archivePath: archive, log: () => {} });
    expect(result.format).toBe("cluster");
    expect(result.databases).toEqual(["appdb", "postgres", "second"]);

    expect(
      sql(
        source,
        "appdb",
        `SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'v', 'S');`,
      ),
    ).toBe("kept,notes,notes_id_seq");
    expect(sql(source, "appdb", "SELECT count(*) FROM pg_proc WHERE proname = 'extra_fn';")).toBe("0");
    expect(sql(source, "appdb", "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension;")).toBe("citext,pg_trgm,plpgsql");
    expect(sql(source, "appdb", "SELECT string_agg(body::text, ',' ORDER BY id) FROM app.notes;")).toBe("alpha,beta");
    expect(sql(source, "second", "SELECT count(*) FROM things;")).toBe("3");
    expect(sql(source, "second", "SELECT to_regclass('public.stray') IS NULL;")).toBe("t");
    expect(databases(source).filter((d) => d.startsWith("vardo_"))).toEqual([]);
  }, 120_000);

  it("round-trips every database, role, owner, grant and setting onto a fresh server", async () => {
    await restorePostgresArchive({ containerId: target, containerEnv: ENV, archivePath: archive, log: () => {} });

    expect(databases(target)).toEqual(["appdb", "postgres", "second"]);
    expect(sql(target, "appdb", "SELECT tableowner FROM pg_tables WHERE tablename = 'notes';")).toBe("owner_role");
    expect(sql(target, "appdb", "SELECT has_table_privilege('reader', 'app.notes', 'SELECT');")).toBe("t");
    expect(sql(target, "appdb", "SELECT has_database_privilege('reader', 'appdb', 'CONNECT');")).toBe("t");
    expect(sql(target, "appdb", "SELECT has_database_privilege('owner_role', 'appdb', 'CONNECT');")).toBe("f");
    expect(sql(target, "appdb", "SHOW search_path;")).toBe("app, public");
    expect(sql(target, "appdb", "SELECT count(*) FROM app.notes WHERE body = 'ALPHA';")).toBe("1");
    expect(sql(target, "postgres", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'second';")).toBe("owner_role");
    expect(sql(target, "second", "SELECT string_agg(name, ',' ORDER BY name) FROM things;")).toBe("one,three,two");
  }, 120_000);

  it("restores an archive from before server archives into the one database, dropping extras", async () => {
    sql(target, "appdb", "CREATE TABLE public.leftover (id int); DELETE FROM app.notes;");
    const result = await restorePostgresArchive({ containerId: target, containerEnv: ENV, archivePath: legacy, log: () => {} });

    expect(result).toEqual({ format: "sql", databases: ["appdb"] });
    expect(sql(target, "appdb", "SELECT to_regclass('public.leftover') IS NULL;")).toBe("t");
    expect(sql(target, "appdb", "SELECT count(*) FROM app.notes;")).toBe("2");
    // Database-level settings the old format never held carry over from the live database.
    expect(sql(target, "appdb", "SHOW search_path;")).toBe("app, public");
    expect(sql(target, "second", "SELECT count(*) FROM things;")).toBe("3");
  }, 120_000);

  describe("onto a server without the dump's roles", () => {
    let fresh: Record<"legacy" | "drill" | "sql" | "custom", string>;

    beforeAll(async () => {
      fresh = {
        legacy: startPostgres("bare-legacy"),
        drill: startPostgres("bare-drill"),
        sql: startPostgres("bare-sql"),
        custom: startPostgres("bare-custom"),
      };
      await Promise.all(Object.values(fresh).map(waitReady));
    }, 180_000);

    const roleExists = (name: string, role: string) =>
      sql(name, "postgres", `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${role}';`);

    it("restores an older single-database archive, creating its owner and grantee as NOLOGIN", async () => {
      const logs: string[] = [];
      const result = await restorePostgresArchive({
        containerId: fresh.legacy,
        containerEnv: ENV,
        archivePath: legacy,
        log: (m) => logs.push(m),
      });

      expect(result).toEqual({ format: "sql", databases: ["appdb"] });
      expect(roleExists(fresh.legacy, "owner_role")).toBe("f");
      expect(roleExists(fresh.legacy, "reader")).toBe("f");
      expect(logs.some((l) => l.includes("NOLOGIN: owner_role, reader"))).toBe(true);
      expect(sql(fresh.legacy, "appdb", "SELECT tableowner FROM pg_tables WHERE tablename = 'notes';")).toBe("owner_role");
      expect(sql(fresh.legacy, "appdb", "SELECT has_table_privilege('reader', 'app.notes', 'SELECT');")).toBe("t");
      expect(sql(fresh.legacy, "appdb", "SELECT count(*) FROM app.notes;")).toBe("2");
    }, 120_000);

    it("passes a drill of an older archive on a scratch server", async () => {
      const plan = scratchDatabaseFor("postgres", IMAGE, ENV)!;
      const verdict = await drillPostgres(fresh.drill, plan.env, plan.countArgv, legacy, () => {});
      expect(verdict.outcome).toBe("verified");
    }, 120_000);

    it("imports a plain pg_dump from another host", async () => {
      const dumped = join(dir, "import.sql.gz");
      writeFileSync(
        dumped,
        gzipSync(execFileSync("docker", ["exec", source, "pg_dump", "-U", "app", "appdb"])),
      );
      const tmp = mkdtempSync(join(dir, "import-sql-"));
      await loadIntoDatabase({
        kind: "postgres",
        containerId: fresh.sql,
        containerEnv: ENV,
        staged: { path: dumped, format: "sql" },
        tmpDir: tmp,
        log: () => {},
      });
      expect(roleExists(fresh.sql, "owner_role")).toBe("f");
      expect(sql(fresh.sql, "appdb", "SELECT tableowner FROM pg_tables WHERE tablename = 'notes';")).toBe("owner_role");
      expect(sql(fresh.sql, "appdb", "SELECT has_table_privilege('reader', 'app.notes', 'SELECT');")).toBe("t");
    }, 120_000);

    it("imports a custom-format pg_dump with its owners and grants", async () => {
      const dumped = join(dir, "import.custom.gz");
      writeFileSync(dumped, gzipSync(execFileSync("docker", ["exec", source, "pg_dump", "-U", "app", "-Fc", "appdb"])));
      const tmp = mkdtempSync(join(dir, "import-custom-"));
      const logs: string[] = [];
      await loadIntoDatabase({
        kind: "postgres",
        containerId: fresh.custom,
        containerEnv: ENV,
        staged: { path: dumped, format: "pg-custom" },
        tmpDir: tmp,
        log: (m) => logs.push(m),
      });
      expect(logs.some((l) => l.includes("NOLOGIN: owner_role, reader"))).toBe(true);
      expect(sql(fresh.custom, "appdb", "SELECT tableowner FROM pg_tables WHERE tablename = 'notes';")).toBe("owner_role");
      expect(sql(fresh.custom, "appdb", "SELECT has_table_privilege('reader', 'app.notes', 'SELECT');")).toBe("t");
      expect(sql(fresh.custom, "appdb", "SELECT count(*) FROM app.notes;")).toBe("2");
    }, 120_000);
  });

  describe("importing a custom-format dump over a database with partitioned tables", () => {
    let part: string;
    let dumped: string;
    const PARTITIONED = `
      CREATE SCHEMA s2;
      CREATE TABLE public.ev (id int, d date, PRIMARY KEY (id, d)) PARTITION BY RANGE (d);
      CREATE TABLE public.ev_2025 PARTITION OF public.ev FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
      CREATE TABLE public.ev_2026 PARTITION OF public.ev FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE VIEW public.ev_view AS SELECT * FROM public.ev;
      CREATE TABLE public.plain (id int);
      CREATE TABLE s2.t (id int PRIMARY KEY) PARTITION BY LIST (id);
      CREATE TABLE s2.t1 PARTITION OF s2.t FOR VALUES IN (1);
      INSERT INTO public.ev VALUES (1, '2025-03-01'), (2, '2026-02-01');
      INSERT INTO s2.t VALUES (1);`;
    const load = () =>
      loadIntoDatabase({
        kind: "postgres",
        containerId: part,
        containerEnv: ENV,
        staged: { path: dumped, format: "pg-custom" },
        tmpDir: mkdtempSync(join(dir, "import-part-")),
        log: () => {},
      });

    beforeAll(async () => {
      part = startPostgres("partitioned");
      await waitReady(part);
      sql(part, "appdb", PARTITIONED);
      dumped = join(dir, "partitioned.custom.gz");
      writeFileSync(dumped, gzipSync(execFileSync("docker", ["exec", part, "pg_dump", "-U", "app", "-Fc", "appdb"])));
    }, 180_000);

    it("replaces the partition trees the dump holds", async () => {
      sql(
        part,
        "appdb",
        `INSERT INTO public.ev VALUES (3, '2026-05-01');
         CREATE TABLE public.ev_2027 PARTITION OF public.ev FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');`,
      );
      await load();

      expect(sql(part, "appdb", "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.ev;")).toBe("1,2");
      expect(sql(part, "appdb", "SELECT to_regclass('public.ev_2027') IS NULL;")).toBe("t");
      expect(sql(part, "appdb", "SELECT count(*) FROM public.ev_view;")).toBe("2");
      expect(sql(part, "appdb", "SELECT count(*) FROM s2.t;")).toBe("1");
    }, 120_000);

    it("reports Postgres's error and changes nothing when the load fails", async () => {
      sql(
        part,
        "appdb",
        `INSERT INTO public.ev VALUES (4, '2026-06-01');
         CREATE SCHEMA keep;
         CREATE VIEW keep.on_plain AS SELECT id FROM public.plain;`,
      );
      const err = await load().catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/restore exited \d+: [\s\S]*cannot drop table public.plain/);
      expect((err as Error).message).not.toContain("EPIPE");
      expect(sql(part, "appdb", "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.ev;")).toBe("1,2,4");
      expect(sql(part, "appdb", "SELECT to_regclass('keep.on_plain') IS NOT NULL;")).toBe("t");
    }, 120_000);
  });

  it("fails loudly and changes nothing when a dump breaks part-way", async () => {
    sql(target, "appdb", "CREATE TABLE public.marker (id int); INSERT INTO public.marker VALUES (42);");
    const broken = join(dir, "broken.dump.gz");
    writeFileSync(broken, gzipSync(Buffer.concat([gunzipSync(readFileSync(legacy)), Buffer.from("\nSELECT * FROM no_such_table;\n")])));

    const logs: string[] = [];
    await expect(
      restorePostgresArchive({ containerId: target, containerEnv: ENV, archivePath: broken, log: (m) => logs.push(m) }),
    ).rejects.toThrow(/Restoring database appdb failed: [\s\S]*no_such_table[\s\S]*The live databases were not changed/);

    expect(sql(target, "appdb", "SELECT id FROM public.marker;")).toBe("42");
    expect(sql(target, "appdb", "SELECT count(*) FROM app.notes;")).toBe("2");
    expect(databases(target).filter((d) => d.startsWith("vardo_"))).toEqual([]);
  }, 120_000);

  it("refuses a truncated server archive without touching any database", async () => {
    const plain = gunzipSync(readFileSync(archive));
    const truncated = join(dir, "truncated.dump.gz");
    writeFileSync(truncated, gzipSync(plain.subarray(0, Math.floor(plain.length * 0.8))));

    await expect(
      restorePostgresArchive({ containerId: target, containerEnv: ENV, archivePath: truncated, log: () => {} }),
    ).rejects.toThrow(/The live databases were not changed/);

    expect(sql(target, "appdb", "SELECT id FROM public.marker;")).toBe("42");
    expect(sql(target, "second", "SELECT count(*) FROM things;")).toBe("3");
    expect(databases(target).filter((d) => d.startsWith("vardo_"))).toEqual([]);
  }, 120_000);
});

// Extension images run only when already pulled, e.g. `docker pull pgvector/pgvector:pg17`.
const EXTENSION_CASES = [
  {
    image: "pgvector/pgvector:pg17",
    seed: "CREATE EXTENSION vector; CREATE TABLE items (id int, embedding vector(3)); INSERT INTO items VALUES (1, '[1,2,3]'); CREATE INDEX ON items USING hnsw (embedding vector_l2_ops);",
    check: "SELECT embedding::text FROM items ORDER BY embedding <-> '[1,2,3]' LIMIT 1;",
    expected: "[1,2,3]",
  },
  ...["postgis/postgis:17-3.5", "imresamu/postgis:17-3.5"].map((image) => ({
    image,
    seed: "CREATE EXTENSION IF NOT EXISTS postgis; CREATE TABLE places (id int, geom geometry(Point, 4326)); INSERT INTO places VALUES (1, ST_SetSRID(ST_MakePoint(-122.6, 45.5), 4326));",
    check: "SELECT ST_AsText(geom) FROM places;",
    expected: "POINT(-122.6 45.5)",
  })),
].filter((c) => imagePresent(c.image));

describe.skipIf(EXTENSION_CASES.length === 0).each(EXTENSION_CASES)("extensions on $image", ({ image, seed, check, expected }) => {
  it("restores the extension's types and indexes and drops extras", async () => {
    const name = startPostgres(image.replace(/[^a-z0-9]/g, "-"), image);
    await waitReady(name);
    const dir = mkdtempSync(join(tmpdir(), "vardo-pg906-ext-"));
    try {
      sql(name, "appdb", seed);
      const file = join(dir, "cluster.dump.gz");
      await dumpCluster(name, file);
      sql(name, "appdb", "CREATE TABLE extra (id int);");

      await restorePostgresArchive({ containerId: name, containerEnv: ENV, archivePath: file, log: () => {} });
      expect(sql(name, "appdb", check)).toBe(expected);
      expect(sql(name, "appdb", "SELECT to_regclass('public.extra') IS NULL;")).toBe("t");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
