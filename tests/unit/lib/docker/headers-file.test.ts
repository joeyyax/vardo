import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  deployHeadersMiddleware,
  headersFileName,
  isValidHeadersFile,
  listHeadersFileAppIds,
  reconcileHeadersFiles,
  removeAppHeadersFile,
  renderHeadersFile,
  writeAppHeadersFile,
} from "@/lib/docker/headers-file";
import { OFF_HEADERS, RECOMMENDED_HEADERS, type SecurityHeaderConfig } from "@/lib/security/response-headers";

const parse = (yaml: string) => YAML.parse(yaml) as { http: { middlewares: Record<string, Record<string, unknown>> } };

describe("renderHeadersFile", () => {
  it("defines one headers middleware named for the app", () => {
    expect(parse(renderHeadersFile("app1", RECOMMENDED_HEADERS))).toEqual({
      http: {
        middlewares: {
          "vardo-headers-app1": {
            headers: {
              stsSeconds: 31_536_000,
              contentTypeNosniff: true,
              customFrameOptionsValue: "SAMEORIGIN",
              referrerPolicy: "strict-origin-when-cross-origin",
            },
          },
        },
      },
    });
  });

  it("renders every header off as an empty chain, which Traefik passes through", () => {
    expect(parse(renderHeadersFile("app1", OFF_HEADERS)).http.middlewares["vardo-headers-app1"]).toEqual({
      chain: { middlewares: [] },
    });
  });

  it("renders the optional headers and keeps quotes intact", () => {
    const config: SecurityHeaderConfig = {
      hsts: { enabled: true, maxAge: 63_072_000, includeSubDomains: true, preload: true },
      nosniff: true,
      framing: "deny",
      referrerPolicy: "no-referrer",
      permissionsPolicy: { mode: "custom", custom: 'geolocation=(self "https://maps.example.com")' },
      cspReportOnly: { enabled: true, policy: "default-src 'self'; script-src 'self' 'nonce-abc'" },
    };
    expect(parse(renderHeadersFile("app1", config)).http.middlewares["vardo-headers-app1"].headers).toEqual({
      stsSeconds: 63_072_000,
      stsIncludeSubdomains: true,
      stsPreload: true,
      contentTypeNosniff: true,
      customFrameOptionsValue: "DENY",
      referrerPolicy: "no-referrer",
      permissionsPolicy: 'geolocation=(self "https://maps.example.com")',
      contentSecurityPolicyReportOnly: "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'",
    });
  });

  it("produces files that validate", () => {
    expect(isValidHeadersFile(renderHeadersFile("app1", RECOMMENDED_HEADERS), "app1")).toBe(true);
    expect(isValidHeadersFile(renderHeadersFile("app1", OFF_HEADERS), "app1")).toBe(true);
  });
});

describe("isValidHeadersFile", () => {
  it.each([
    ["an empty headers block", "http:\n  middlewares:\n    vardo-headers-app1:\n      headers: {}\n"],
    ["an empty value", "http:\n  middlewares:\n    vardo-headers-app1:\n      headers:\n        referrerPolicy: ''\n"],
    ["another app's name", "http:\n  middlewares:\n    vardo-headers-app2:\n      headers:\n        contentTypeNosniff: true\n"],
    ["a router", "http:\n  routers:\n    x: {}\n  middlewares:\n    vardo-headers-app1:\n      chain:\n        middlewares: []\n"],
    ["broken YAML", "http: [\n"],
  ])("refuses %s", (_label, content) => {
    expect(isValidHeadersFile(content, "app1")).toBe(false);
  });
});

describe("file lifecycle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headers-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes, skips an identical rewrite, rewrites a change and removes", async () => {
    expect(await writeAppHeadersFile("app1", RECOMMENDED_HEADERS, dir)).toBe("written");
    expect(await writeAppHeadersFile("app1", RECOMMENDED_HEADERS, dir)).toBe("unchanged");
    expect(await writeAppHeadersFile("app1", OFF_HEADERS, dir)).toBe("written");
    expect(readFileSync(join(dir, headersFileName("app1")), "utf8")).toContain("chain:");
    expect(readdirSync(dir)).toEqual(["vardo-headers-app1.yaml"]);
    await removeAppHeadersFile("app1", dir);
    expect(existsSync(join(dir, headersFileName("app1")))).toBe(false);
    await expect(removeAppHeadersFile("app1", dir)).resolves.toBeUndefined();
  });

  it("names files so no app route file can replace one", () => {
    expect(headersFileName("app1")).toBe("vardo-headers-app1.yaml");
    expect(() => headersFileName("../etc/passwd")).toThrow();
  });

  it("skips quietly where the Traefik volume is missing", async () => {
    expect(await writeAppHeadersFile("app1", RECOMMENDED_HEADERS, join(dir, "missing", "deeper"))).toBe("written");
    chmodSync(dir, 0o500);
    expect(await writeAppHeadersFile("app2", RECOMMENDED_HEADERS, join(dir, "ro"))).toBe("skipped");
  });

  it("reconciles: writes listed apps and removes files for apps that are gone", async () => {
    writeFileSync(join(dir, "vardo-headers-gone.yaml"), "x");
    writeFileSync(join(dir, "someapp.yml"), "x");
    writeFileSync(join(dir, "vardo-reach.yaml"), "x");
    const result = await reconcileHeadersFiles(
      [
        { id: "app1", config: RECOMMENDED_HEADERS },
        { id: "app2", config: OFF_HEADERS },
      ],
      dir,
    );
    expect(result).toEqual({ written: 2, removed: 1 });
    expect((await listHeadersFileAppIds(dir)).sort()).toEqual(["app1", "app2"]);
    expect(readdirSync(dir).sort()).toEqual(["someapp.yml", "vardo-headers-app1.yaml", "vardo-headers-app2.yaml", "vardo-reach.yaml"]);
  });
});

describe("deployHeadersMiddleware", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "headers-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("references the file once it's written, even with every header off", async () => {
    expect(await deployHeadersMiddleware("app1", OFF_HEADERS, dir)).toEqual({
      headers: { ref: "vardo-headers-app1@file" },
      live: true,
    });
    expect(existsSync(join(dir, "vardo-headers-app1.yaml"))).toBe(true);
  });

  it("falls back to label options without a writable volume", async () => {
    chmodSync(dir, 0o500);
    const plan = await deployHeadersMiddleware("app1", RECOMMENDED_HEADERS, join(dir, "traefik"));
    expect(plan.live).toBe(false);
    expect(plan.headers).toEqual({
      options: {
        stsSeconds: "31536000",
        contentTypeNosniff: "true",
        customFrameOptionsValue: "SAMEORIGIN",
        referrerPolicy: "strict-origin-when-cross-origin",
      },
    });
    expect((await deployHeadersMiddleware("app1", OFF_HEADERS, join(dir, "traefik"))).headers).toBeNull();
  });
});
