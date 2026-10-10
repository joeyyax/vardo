// The security_headers boolean to security_header_config move, as text and replayed on a scratch database.

import { afterAll, describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, projectBefore, runMigrate, scratchName } from "./scratch-db";
import { OFF_HEADERS, RECOMMENDED_HEADERS, normalizeHeaderConfig } from "@/lib/security/response-headers";

const DIR = join(process.cwd(), "drizzle");
const NAME = readdirSync(DIR).find((f) => /^\d{4}_security_header_settings\.sql$/.test(f))!;
const statements = readFileSync(join(DIR, NAME), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--(?!>).*$/gm, "").trim());

const jsonIn = (s: string) => JSON.parse(/'(\{.*\})'::jsonb/.exec(s)![1]);

describe("security header settings migration", () => {
  const add = statements.find((s) => s.includes('ADD COLUMN "security_header_config"'))!;
  const update = statements.find((s) => /^UPDATE "app"/.test(s))!;
  const drop = statements.findIndex((s) => s.includes('DROP COLUMN "security_headers"'));

  it("defaults every row, so apps with headers on, to Recommended", () => {
    expect(add).toMatch(/NOT NULL/);
    expect(normalizeHeaderConfig(jsonIn(add))).toEqual(RECOMMENDED_HEADERS);
    expect(jsonIn(add)).toEqual(RECOMMENDED_HEADERS);
  });

  it("maps apps with headers off to every header off", () => {
    expect(update).toMatch(/WHERE "security_headers" = false;$/);
    expect(jsonIn(update)).toEqual(OFF_HEADERS);
  });

  it("reads the old column before dropping it", () => {
    expect(drop).toBeGreaterThan(statements.indexOf(update));
    expect(statements.indexOf(update)).toBeGreaterThan(statements.indexOf(add));
  });

  it("starts every app as needing one redeploy to go live", () => {
    expect(statements.find((s) => s.includes('"security_headers_live"'))).toMatch(/boolean DEFAULT false NOT NULL/);
  });
});

const conn = await connectScratchServer();

describe.skipIf(!conn)("security header settings migration on a scratch database", { timeout: MIGRATE_TIMEOUT }, () => {
  afterAll(() => conn!.dropAll(), MIGRATE_TIMEOUT);

  it("gives apps that had headers on Recommended and apps that had them off every header off", async () => {
    const url = await conn!.create(scratchName("headers"));
    expect((await runMigrate(url, projectBefore(NAME.slice(0, -4)))).code).toBe(0);
    const before = postgres(url, { max: 1, onnotice: () => {} });
    // Skips foreign keys so the rows need no organization or project.
    await before.unsafe("SET session_replication_role = replica");
    await before.unsafe(
      `INSERT INTO "app" (id, organization_id, project_id, name, display_name, source, deploy_type, security_headers)
       VALUES ('a-on', 'o', 'p', 'on', 'On', 'git', 'compose', true), ('a-off', 'o', 'p', 'off', 'Off', 'git', 'compose', false)`,
    );
    await before.end({ timeout: 1 });

    const run = await runMigrate(url);
    expect(run.code, run.out).toBe(0);
    const after = postgres(url, { max: 1, onnotice: () => {} });
    const rows = await after<{ id: string; config: unknown; live: boolean }[]>`
      SELECT id, security_header_config AS config, security_headers_live AS live FROM app ORDER BY id`;
    await after.end({ timeout: 1 });
    expect(rows).toEqual([
      { id: "a-off", config: OFF_HEADERS, live: false },
      { id: "a-on", config: RECOMMENDED_HEADERS, live: false },
    ]);
  });
});
