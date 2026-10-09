import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { CONSOLE_PUBLIC_FILE, consoleLock, consolePublicConfig, syncConsolePublicRoute } from "@/lib/docker/console-lock";

const locked = { VARDO_DOMAIN: "vardo.example.com", VARDO_CONSOLE_MIDDLEWARES: "cloudflare-only@file" };

describe("consolePublicConfig", () => {
  it("is absent without a lock, so nothing changes", () => {
    expect(consolePublicConfig({ VARDO_DOMAIN: "vardo.example.com" })).toBeNull();
    expect(consolePublicConfig({ VARDO_DOMAIN: "vardo.example.com", VARDO_CONSOLE_MIDDLEWARES: " " })).toBeNull();
  });

  it("routes only the health check and the webhook, unlocked, ahead of the console's router", () => {
    const router = (consolePublicConfig(locked) as { http: { routers: Record<string, Record<string, unknown>> } }).http.routers["vardo-console-public"];
    expect(router.rule).toBe("Host(`vardo.example.com`) && (Path(`/api/health`) || Path(`/api/v1/github/webhook`))");
    expect(router.service).toBe("vardo@docker");
    expect(router.middlewares).toBeUndefined();
    expect(router.priority).toBe(100000);
    expect(router.tls).toEqual({ certResolver: "le" });
  });

  it("uses the console's certificate resolver", () => {
    const config = consolePublicConfig({ ...locked, VARDO_CONSOLE_CERT_RESOLVER: "le-dns" }) as { http: { routers: Record<string, { tls: unknown }> } };
    expect(config.http.routers["vardo-console-public"].tls).toEqual({ certResolver: "le-dns" });
  });

  it("needs a real console hostname", () => {
    expect(consolePublicConfig({ ...locked, VARDO_DOMAIN: "localhost" })).toBeNull();
    expect(consolePublicConfig({ ...locked, VARDO_DOMAIN: "a`) || Host(`b" })).toBeNull();
  });
});

describe("consoleLock", () => {
  it("reports entries Traefik can't read", () => {
    expect(consoleLock({ VARDO_CONSOLE_MIDDLEWARES: "cloudflare-only@file, tailscale-only@file" }).invalid).toEqual([]);
    expect(consoleLock({ VARDO_CONSOLE_MIDDLEWARES: "cloudflare-only@file,bad name" }).invalid).toEqual(["bad name"]);
  });
});

describe("syncConsolePublicRoute", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "console-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the file when locked and removes it when the lock goes", async () => {
    expect(await syncConsolePublicRoute({ dir, env: locked })).toBe("written");
    const written = YAML.parse(await readFile(join(dir, CONSOLE_PUBLIC_FILE), "utf-8"));
    expect(Object.keys(written.http.routers)).toEqual(["vardo-console-public"]);

    expect(await syncConsolePublicRoute({ dir, env: { VARDO_DOMAIN: "vardo.example.com" } })).toBe("removed");
    await expect(stat(join(dir, CONSOLE_PUBLIC_FILE))).rejects.toThrow();
  });

  it("writes nothing when unlocked", async () => {
    expect(await syncConsolePublicRoute({ dir, env: { VARDO_DOMAIN: "vardo.example.com" } })).toBe("removed");
    await expect(stat(join(dir, CONSOLE_PUBLIC_FILE))).rejects.toThrow();
  });
});
