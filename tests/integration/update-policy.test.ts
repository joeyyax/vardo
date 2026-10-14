// Saving the update policy from MCP and PUT /api/v1/admin/updates against a scratch database.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import { adminContext, captureTools, plainContext, toolBody } from "@/tests/helpers/mcp-tools";
import { jsonRequest } from "@/tests/helpers/request";

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: async () => true }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/self-update/status", () => ({ getUpdateStatus: async () => ({ ok: true }) }));

const conn = await connectScratchServer();

const ADMIN = "u-admin";
const MEMBER = "u-member";

describe.skipIf(!conn)("update policy on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("update_policy");
  let sql: ReturnType<typeof postgres>;
  let registerUpdatePolicyTools: typeof import("@/lib/mcp/tools/update-policy").registerUpdatePolicyTools;
  let getUpdatePolicy: typeof import("@/lib/self-update/store").getUpdatePolicy;
  let setUpdatePolicy: typeof import("@/lib/self-update/store").setUpdatePolicy;
  let PUT: typeof import("@/app/api/v1/admin/updates/route").PUT;

  const tools = (userId: string, context = adminContext) =>
    captureTools(registerUpdatePolicyTools, { ...context, userId, organizationId: "o1" });
  const setTool = (userId = ADMIN) => tools(userId).get("vardo_set_update_policy")!;
  const policyRows = () =>
    sql<{ user_id: string; metadata: Record<string, unknown> }[]>`
      select user_id, metadata from activity where action = 'system.update_policy_changed' order by created_at`;

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('o1', 'Shop', 'shop')`;
    await sql`insert into "user" (id, email, email_verified, is_app_admin) values
      (${ADMIN}, 'admin@example.com', true, true), (${MEMBER}, 'member@example.com', true, false)`;
    await sql`insert into membership (id, organization_id, user_id, role) values
      ('m1', 'o1', ${ADMIN}, 'owner'), ('m2', 'o1', ${MEMBER}, 'admin')`;
    ({ registerUpdatePolicyTools } = await import("@/lib/mcp/tools/update-policy"));
    ({ getUpdatePolicy, setUpdatePolicy } = await import("@/lib/self-update/store"));
    ({ PUT } = await import("@/app/api/v1/admin/updates/route"));
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    await sql`delete from activity`;
    await setUpdatePolicy({ mode: "notify", priority: "standard", channel: null });
    h.session = null;
  });

  it("saves what getUpdatePolicy then returns and logs the change", async () => {
    const body = toolBody(await setTool()({ mode: "auto", priority: "critical" }));
    expect(body).toEqual({ mode: "auto", priority: "critical", channel: null, effectiveChannel: "releases" });
    expect(await getUpdatePolicy()).toEqual({ mode: "auto", priority: "critical", channel: null });

    const rows = await policyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: ADMIN, metadata: { mode: "auto", priority: "critical", channel: null } });
  });

  it("keeps omitted fields and sets the channel back to the default with null", async () => {
    await setTool()({ channel: "main" });
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: "main" });
    await setTool()({ priority: "low", channel: null });
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "low", channel: null });
  });

  it("doesn't log a save that changes nothing", async () => {
    await setTool()({ mode: "notify" });
    expect(await policyRows()).toHaveLength(0);
  });

  it("refuses a bad value and leaves the policy alone", async () => {
    const res = await setTool()({ mode: "sometimes" });
    expect(res.isError).toBe(true);
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: null });
    expect(await policyRows()).toHaveLength(0);
  });

  it("refuses an admin-scoped token whose user isn't an instance admin", async () => {
    const res = await setTool(MEMBER)({ mode: "auto" });
    expect(res.isError).toBe(true);
    expect(toolBody(res).error).toMatch(/admin scope/);
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: null });
    expect(await policyRows()).toHaveLength(0);
  });

  it("isn't offered to a token without the admin scope", () => {
    const names = [...tools(ADMIN, plainContext).keys()];
    expect(names).not.toContain("vardo_set_update_policy");
    expect(names).not.toContain("vardo_get_update_policy");
  });

  it("answers 403 to a PUT from a token without the admin scope and leaves the policy alone", async () => {
    h.session = { user: { id: ADMIN }, authMethod: "token", tokenScope: { admin: false } };
    const res = await PUT(jsonRequest("PUT", "/api/v1/admin/updates", { body: { mode: "auto", priority: "low", channel: null } }));
    expect(res.status).toBe(403);
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: null });
    expect(await policyRows()).toHaveLength(0);
  });

  it("answers 403 to a PUT from a non-admin session", async () => {
    h.session = { user: { id: MEMBER }, authMethod: "session" };
    const res = await PUT(jsonRequest("PUT", "/api/v1/admin/updates", { body: { mode: "auto", priority: "low", channel: null } }));
    expect(res.status).toBe(403);
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: null });
  });

  it("saves and logs a PUT through the same path", async () => {
    h.session = { user: { id: ADMIN }, authMethod: "session" };
    const res = await PUT(jsonRequest("PUT", "/api/v1/admin/updates", { body: { mode: "off", priority: "low", channel: "main" } }));
    expect(res.status).toBe(200);
    expect(await getUpdatePolicy()).toEqual({ mode: "off", priority: "low", channel: "main" });
    expect(await policyRows()).toEqual([
      expect.objectContaining({ user_id: ADMIN, metadata: { mode: "off", priority: "low", channel: "main" } }),
    ]);
  });

  it("refuses a PUT with a bad value", async () => {
    h.session = { user: { id: ADMIN }, authMethod: "session" };
    const res = await PUT(jsonRequest("PUT", "/api/v1/admin/updates", { body: { mode: "auto", priority: "urgent", channel: null } }));
    expect(res.status).toBe(400);
    expect(await getUpdatePolicy()).toEqual({ mode: "notify", priority: "standard", channel: null });
  });
});
