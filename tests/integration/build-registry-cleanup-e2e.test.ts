// Cleanup against a real registry:2 with deletes on. Runs only with VARDO_E2E_CLEANUP_REGISTRY set to its
// "host:port", plus VARDO_E2E_CLEANUP_USER and VARDO_E2E_CLEANUP_PASSWORD when it uses htpasswd.
// VARDO_E2E_CLEANUP_CONTAINER names the registry's container, to print its disk use around the cleanup.

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: async () => null, setSystemSetting: async () => {} }));

const registryHost = process.env.VARDO_E2E_CLEANUP_REGISTRY;
const username = process.env.VARDO_E2E_CLEANUP_USER ?? "";
const password = process.env.VARDO_E2E_CLEANUP_PASSWORD ?? "";
const container = process.env.VARDO_E2E_CLEANUP_CONTAINER;

const { runRegistryCleanup, registryClient, registryBaseUrl, listTags } = await import("@/lib/docker/build-registry-cleanup");

const docker = (args: string[], env?: NodeJS.ProcessEnv, cwd?: string) =>
  execFileAsync("docker", args, { env, cwd, timeout: 300_000 }).then((r) => String(r.stdout).trim());
const diskUse = async () => (container ? `${(await docker(["exec", container, "du", "-sk", "/var/lib/registry"])).split(/\s+/)[0]} KiB` : "n/a");

describe.skipIf(!registryHost)("build registry cleanup against registry:2", () => {
  const app = `e2e-cleanup-${Date.now().toString(36)}`;
  const local: string[] = [];
  let dir: string;

  afterAll(async () => {
    for (const image of local) await docker(["image", "rm", "-f", image]).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("deletes all but the newest three tags of an app's repo", async () => {
    const config = { url: `${registryHost}/vardo`, username, password };
    dir = await mkdtemp(join(tmpdir(), "vardo-cleanup-"));
    await writeFile(join(dir, "Dockerfile"), "FROM busybox:1.36\nARG N\nRUN head -c 20000000 /dev/urandom > /blob-$N\n");
    const auth = join(dir, "auth");
    await mkdir(auth);
    await writeFile(join(auth, "config.json"), JSON.stringify({ auths: username ? { [registryHost!]: { auth: Buffer.from(`${username}:${password}`).toString("base64") } } : {} }));
    for (let n = 0; n < 5; n++) {
      const ref = `${registryHost}/vardo/${app}:key${n}`;
      await docker(["build", "-q", "--build-arg", `N=${n}`, "-t", ref, "."], undefined, dir);
      await docker(["push", "--quiet", ref], { ...process.env, DOCKER_CONFIG: auth });
      local.push(ref);
      // Distinct build times, newest last.
      await new Promise((r) => setTimeout(r, 1100));
    }

    const client = registryClient(registryBaseUrl(config.url)!, username ? { username, password } : null);
    console.log(`[e2e] before: ${(await listTags(client, `vardo/${app}`)).sort().join(" ")} (${await diskUse()})`);
    const result = await runRegistryCleanup({ config, now: Date.now() + 2 * 24 * 60 * 60_000, state: { appNames: [app], inUse: new Set() } });
    const left = (await listTags(client, `vardo/${app}`)).sort();
    console.log(`[e2e] cleanup: deleted ${result?.deleted}, kept ${result?.kept}${result?.error ? `, error ${result.error}` : ""}`);
    console.log(`[e2e] removed: ${result?.removed.join(" ")}`);
    console.log(`[e2e] after: ${left.join(" ")} (${await diskUse()})`);

    expect(result?.error).toBeUndefined();
    expect(left).toEqual(["key2", "key3", "key4"]);
  }, 300_000);
});
