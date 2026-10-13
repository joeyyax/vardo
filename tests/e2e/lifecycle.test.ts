import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

test.setTimeout(300_000);

function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function doneEvent(stream: string): { success: boolean; deploymentId: string; error?: string } {
  const match = [...stream.matchAll(/event: done\ndata: (.+)/g)].at(-1);
  expect(match, stream.slice(-1_000)).toBeDefined();
  return JSON.parse(match![1]);
}

async function deploy(page: Page, slug: string) {
  await page.goto(`/apps/${slug}`);
  const pending = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/deploy"),
    { timeout: 45_000 },
  );
  const button = page.getByRole("button", { name: "Deploy", exact: true }).first();
  if (await button.count()) {
    await button.click();
  } else {
    await page.getByRole("button", { name: /^Running/ }).click();
    await page.getByRole("menuitem", { name: "Deploy", exact: true }).click();
  }
  const response = await pending;
  expect(response.status()).toBe(200);
  const result = doneEvent(await response.text());
  expect(result.success, result.error).toBe(true);
  return result.deploymentId;
}

test("create, deploy, back up, restore, stop, recreate and roll back an app", async ({ page }) => {
  docker("info", "--format", "{{.ServerVersion}}");
  const slug = `e2e-lifecycle-${Date.now().toString(36)}`;
  const container = `${slug}-production-blue-web-1`;
  const volume = `${slug}-production_e2e-data`;
  const targetPath = path.resolve(".host/local-backups", slug);
  const file = "/usr/share/nginx/html/e2e-check.txt";
  mkdirSync(targetPath, { recursive: true });
  let orgId = "";
  let appId = "";

  try {
    await page.goto("/setup");
    await page.getByLabel("Setup token").fill("e2e-setup-token-0123456789");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Lifecycle E2E");
    await page.getByRole("textbox", { name: "Email" }).fill(`${slug}@example.test`);
    await page.getByRole("textbox", { name: "Password" }).fill("TestPassword123!");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/projects");

    await page.goto("/apps/new");
    await page.getByRole("button", { name: "Docker Compose Paste or from a repo" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Lifecycle E2E app");
    await page.getByRole("textbox", { name: "Slug" }).fill(slug);
    await page.getByRole("switch", { name: "Generate public URL" }).click();
    await page.getByRole("switch", { name: "Auto deploy" }).click();
    await page.getByRole("textbox", { name: /services: app:/ }).fill(
      "services:\n  web:\n    image: nginx:alpine\n    network_mode: bridge\n    volumes:\n      - e2e-data:/usr/share/nginx/html\nvolumes:\n  e2e-data:\n",
    );
    await page.getByRole("combobox").last().click();
    await page.getByRole("option", { name: "Create new project..." }).click();
    await page.getByRole("textbox", { name: "New project name" }).fill("Lifecycle E2E project");
    await page.getByRole("button", { name: "Create app" }).click();
    const created = page.waitForResponse((response) =>
      response.request().method() === "POST" && /\/organizations\/[^/]+\/apps$/.test(response.url()),
    );
    await page.getByRole("dialog").getByRole("button", { name: "Deploy" }).click();
    const appResponse = await created;
    expect(appResponse.status()).toBe(201);
    appId = (await appResponse.json()).app.id;
    orgId = new URL(appResponse.url()).pathname.split("/")[4];

    const firstDeployment = await deploy(page, slug);
    await expect.poll(() => docker("ps", "--format", "{{.Names}}", "--filter", `name=${slug}`)).toContain(container);

    const targets = await page.request.post(`/api/v1/organizations/${orgId}/backups/targets`, {
      data: { name: "E2E local", type: "local", config: { path: targetPath }, isDefault: true },
    });
    expect(targets.status(), await targets.text()).toBe(201);
    docker("exec", container, "sh", "-c", `printf before-backup > ${file}`);
    const backupStart = await page.request.post(`/api/v1/organizations/${orgId}/apps/${appId}/backup-now`, {
      data: {},
    });
    expect(backupStart.status(), await backupStart.text()).toBe(202);
    let backupId = "";
    await expect.poll(async () => {
      const response = await page.request.get(`/api/v1/organizations/${orgId}/backups?appId=${appId}`);
      const history = (await response.json()).recentHistory?.[0];
      backupId = history?.id ?? "";
      return history?.status;
    }, { timeout: 120_000, intervals: [1_000, 2_000] }).toBe("success");
    docker("exec", container, "sh", "-c", `printf after-backup > ${file}`);
    const restored = await page.request.post(
      `/api/v1/organizations/${orgId}/backups/history/${backupId}/restore`,
    );
    expect(restored.status(), await restored.text()).toBe(200);
    expect((await restored.json()).success).toBe(true);
    expect(docker("exec", container, "cat", file)).toBe("before-backup");

    await page.goto(`/apps/${slug}`);
    await page.getByRole("button", { name: /^Running/ }).click();
    await page.getByRole("menuitem", { name: "Stop" }).click();
    const stopped = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/stop"),
    );
    await page.getByRole("alertdialog", { name: "Stop app" }).getByRole("button", { name: "Stop" }).click();
    expect((await (await stopped).json()).success).toBe(true);
    await expect(page.getByRole("alertdialog", { name: "Stop app" })).toBeHidden();
    await expect.poll(() => docker("ps", "--format", "{{.Names}}", "--filter", `name=${slug}`)).toBe("");

    await page.reload();
    await page.getByRole("button", { name: /^(Stopped|No container)$/ }).click();
    const recreated = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/recreate"),
    );
    await page.getByRole("menuitem", { name: "Recreate containers" }).click();
    expect((await (await recreated).json()).success).toBe(true);
    await expect.poll(() => docker("ps", "--format", "{{.Names}}", "--filter", `name=${slug}`)).toContain(container);

    await deploy(page, slug);
    const rollback = await page.request.post(`/api/v1/organizations/${orgId}/apps/${appId}/rollback`, {
      data: { deploymentId: firstDeployment },
    });
    expect(rollback.status()).toBe(200);
    expect(doneEvent(await rollback.text()).success).toBe(true);
  } finally {
    if (orgId && appId) {
      await page.request.delete(`/api/v1/organizations/${orgId}/apps/${appId}`, {
        data: { deleteVolumes: true },
      }).catch(() => {});
    }
    for (const slot of ["blue", "green"]) {
      spawnSync("docker", ["rm", "-f", `${slug}-production-${slot}-web-1`], { stdio: "ignore" });
    }
    spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
    rmSync(targetPath, { recursive: true, force: true });
  }
});
