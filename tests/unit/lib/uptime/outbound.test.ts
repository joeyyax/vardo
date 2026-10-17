import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ allowlist: [] as string[] }));

vi.mock("@/lib/security/outbound-policy", () => ({ getDomainProbePolicy: async () => ({ allowlist: h.allowlist }) }));
vi.mock("@/lib/incidents/key", () => ({ consoleBaseUrl: () => "https://console.example.com" }));

import { runHttpCheck, runTcpCheck, runTlsCheck, type HttpCheck } from "@/lib/uptime/core";
import { checkDeps, levelOf, targetRefusal } from "@/lib/uptime/outbound";

const http = (url: string): HttpCheck => ({ type: "http", url, expectedStatus: { min: 200, max: 399 }, timeoutMs: 2000 });
const ctx = { monitorId: "m", vantageId: "v", path: "public" as const };

describe("target refusal at create and update", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://10.99.0.2:3000/api/health",
    "http://10.0.0.5",
    "http://192.168.1.10",
    "http://[::1]:8080",
    "http://[fd00::1]",
  ])("strict refuses %s", async (url) => {
    expect(await targetRefusal(http(url), "strict")).toMatch(/resolves to/);
  });

  it("refuses private tcp and tls hosts", async () => {
    expect(await targetRefusal({ type: "tcp", host: "192.168.1.1", port: 22 }, "strict")).not.toBeNull();
    expect(await targetRefusal({ type: "tls", host: "10.99.0.4", port: 443, warnDays: 14 }, "strict")).not.toBeNull();
  });

  it("allows a public address", async () => {
    expect(await targetRefusal(http("https://93.184.216.34/health"), "strict")).toBeNull();
  });

  it("lets the operator policy reach an allowlisted private host, but never link-local", async () => {
    h.allowlist = ["10.0.0.5", "169.254.169.254"];
    expect(await targetRefusal(http("http://10.0.0.5:8080"), "operator")).toBeNull();
    expect(await targetRefusal(http("http://10.0.0.5:8080"), "strict")).not.toBeNull();
    expect(await targetRefusal(http("http://169.254.169.254"), "operator")).toMatch(/link-local/);
    expect(await targetRefusal(http("http://10.0.0.6"), "operator")).not.toBeNull();
    h.allowlist = [];
  });

  it("picks the level: manual org monitors strict, automatic and instance monitors operator", () => {
    expect(levelOf({ organizationId: "o", source: "manual" })).toBe("strict");
    expect(levelOf({ organizationId: "o", source: "auto" })).toBe("operator");
    expect(levelOf({ organizationId: null, source: "manual" })).toBe("operator");
  });
});

describe("checks under the policy", () => {
  it("blocks an http check at connect and records it as blocked", async () => {
    const { fetch } = await checkDeps("strict");
    const result = await runHttpCheck(http("http://169.254.169.254/latest/meta-data"), { ...ctx, fetch });
    expect(result).toMatchObject({ ok: false, error: "blocked" });
  });

  it("blocks a redirect-free private literal for the operator too", async () => {
    const { fetch } = await checkDeps("operator");
    expect(await runHttpCheck(http("http://169.254.169.254/"), { ...ctx, fetch })).toMatchObject({ error: "blocked" });
  });

  it("skips the connection when the guard refuses a tcp or tls host", async () => {
    const { guard } = await checkDeps("strict");
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const tcp = await runTcpCheck({ type: "tcp", host: "10.99.0.2", port: 22 }, { ...ctx, guard, connect: connect as never });
    const tls = await runTlsCheck({ type: "tls", host: "127.0.0.1", port: 443, warnDays: 14 }, { ...ctx, guard, connect: connect as never });
    expect(tcp).toMatchObject({ ok: false, error: "blocked" });
    expect(tls).toMatchObject({ ok: false, error: "blocked" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("cached resolution", () => {
  it("vets the cached addresses and resolves the host once for the policy check", async () => {
    const { blockedHostReason } = await import("@/lib/uptime/outbound");
    const resolve = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    expect(await blockedHostReason("app.example.com", { resolve }, "strict")).toMatch(/10\.0\.0\.5/);
    expect(resolve).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(await blockedHostReason("app.example.com", { resolve: ok }, "strict")).toBeNull();
  });

  it("gives the fetch the same resolver, so the policy check and the connect share an answer", async () => {
    const { assertOutboundUrlAllowed } = await import("@/lib/security/ssrf");
    const resolve = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    await expect(assertOutboundUrlAllowed("https://app.example.com/", { resolve })).rejects.toThrow(/169\.254\.169\.254/);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
