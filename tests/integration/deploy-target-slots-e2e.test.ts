// Two queued deploys at a deploy limit of one, the second claimed on a real SSH build target's slot and built there.
// Runs only with VARDO_E2E_TARGET set to "user@host:port" and VARDO_E2E_TARGET_KEY to a private key file,
// a Postgres it can create databases on and Redis at REDIS_URL or localhost:7200. Images come back over SSH.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import postgres from "postgres";
import { execFileAsync } from "@/lib/utils/exec";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const spec = process.env.VARDO_E2E_TARGET?.match(/^([^@]+)@(.+):(\d+)$/);
const enabled = Boolean(spec && process.env.VARDO_E2E_TARGET_KEY);
const conn = enabled ? await connectScratchServer() : null;

describe.skipIf(!conn)("deploys on a real build target's slot", { timeout: 300_000 }, () => {
  const tag = `ts${Date.now().toString(36)}`;
  const prefix = `test:target-slots-e2e:${process.pid}:${Date.now()}`;
  const dbName = scratchName("targetslotse2e");
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  const local: string[] = [];
  let dir: string;
  let sql: ReturnType<typeof postgres>;
  let target: import("@/lib/docker/build-targets").BuildTarget;
  let q: typeof import("@/lib/deploy/queue");
  let gate: typeof import("@/lib/docker/build-gate");
  let targets: typeof import("@/lib/docker/build-targets");
  let dockerEnv: typeof import("@/lib/docker/docker-env").dockerEnv;

  const run = (args: string[], env?: NodeJS.ProcessEnv, cwd?: string) =>
    execFileAsync("docker", args, { env: env ?? dockerEnv(), cwd, timeout: 300_000 }).then((r) => String(r.stdout).trim());

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 4, onnotice: () => {} });
    await sql.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      for (const id of ["a1", "a2"]) {
        await t`insert into app (id, organization_id, name, display_name, project_id) values (${id}, 'o1', ${id}, ${id}, 'p1')`;
      }
    });
    q = await import("@/lib/deploy/queue");
    gate = await import("@/lib/docker/build-gate");
    targets = await import("@/lib/docker/build-targets");
    dockerEnv = (await import("@/lib/docker/docker-env")).dockerEnv;
    (await import("@/lib/resources/host")).setResourceSettingsCache({ deployConcurrency: 1 });
    const keys = Object.fromEntries(
      ["queue", "seen", "running", "hold", "admits", "started", "remote", "target", "ready"].map((k) => [k, `${prefix}:${k}${k === "target" ? ":" : ""}`]),
    ) as Parameters<typeof gate.redisBuildStore>[0];
    gate.resetBuildGateForTests(gate.redisBuildStore(keys));
    dir = await mkdtemp(join(tmpdir(), "vardo-e2e-slots-"));
    const [, user, host, port] = spec!;
    target = {
      id: "e2e-lh", kind: "ssh", name: "Long House", host, port: Number(port), user,
      privateKey: await readFile(process.env.VARDO_E2E_TARGET_KEY!, "utf-8"),
      hostKey: await targets.scanHostKey(host, Number(port)),
      maxConcurrent: 1,
    };
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    for (const image of local) await run(["image", "rm", "-f", image]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    const { redis } = await import("@/lib/redis");
    const left = await redis.keys(`${prefix}:*`);
    if (left.length > 0) await redis.del(...left);
    redis.disconnect();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  async function context(name: string): Promise<{ src: string; image: string }> {
    const src = join(dir, name);
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Dockerfile"), `FROM busybox:1.36\nRUN echo ${name}-${tag} > /built\n`);
    const image = `vardo-e2e-slots-${name}:${tag}`;
    local.push(image);
    return { src, image };
  }

  it("claims both, builds the first here and the second on the target, and brings its image back", async () => {
    expect(await targets.isTargetReady(target)).toBe(true);
    await sql`insert into deployment (id, app_id, trigger, status, scope_key, started_at) values
      ('d1', 'a1', 'manual', 'queued', 'a1', now() - interval '20 seconds'),
      ('d2', 'a2', 'manual', 'queued', 'a2', now() - interval '10 seconds')`;

    const view = await gate.targetSlotView({ load: async () => [target] });
    expect(view).toMatchObject({ slots: 1, holders: [], names: ["Long House"] });
    const claimed = await q.claimDeploys("e2e", { targets: view });
    expect(claimed.map((c) => [c.id, c.onTarget ?? false])).toEqual([["d1", false], ["d2", true]]);
    log(claimed[1].note!);

    const bounded = { env: {}, loadArgs: [], limitBytes: null };
    const placed: Record<string, string> = {};
    const buildOn = (id: string, ctx: { src: string; image: string }) => async ({ target: on }: { target: typeof target | null }) => {
      placed[id] = on ? on.name : "this server";
      const args = ["build", "--progress=plain", "-t", ctx.image, ctx.src];
      if (!on) return void (await run(args, undefined, ctx.src));
      const { bringBack, TARGET_BUILD } = await import("@/lib/docker/remote-build");
      await targets.onTarget(on, async (session) => {
        await run(["build", ...TARGET_BUILD.loadArgs, "--progress=plain", "-t", ctx.image, ctx.src], targets.remoteEnv(dockerEnv(), session), ctx.src);
        await bringBack([{ image: ctx.image, ref: null }], { authEnv: dockerEnv(), session, from: on.name, log });
      });
    };
    const one = await context("one");
    const two = await context("two");
    await Promise.all([
      gate.withBuildSlot({ deploymentId: "d1", log, targets: [target], deploySlot: q.claimedSlot("e2e", claimed[0]) }, bounded, buildOn("d1", one)),
      gate.withBuildSlot({ deploymentId: "d2", log, targets: [target], deploySlot: q.claimedSlot("e2e", claimed[1]) }, bounded, buildOn("d2", two)),
    ]);

    expect(placed).toEqual({ d1: "this server", d2: "Long House" });
    expect(await run(["run", "--rm", one.image, "cat", "/built"])).toBe(`one-${tag}`);
    expect(await run(["run", "--rm", two.image, "cat", "/built"])).toBe(`two-${tag}`);
    console.log(lines.join("\n"));
  });
});
