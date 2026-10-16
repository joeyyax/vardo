import { describe, expect, it } from "vitest";
import { loopsInWeb, webLoopsEnabled, workerDrainMs, workerExpected, workerHealthPort, workerMode } from "@/lib/worker/mode";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("worker mode", () => {
  it("embeds the worker in dev and expects a container in production", () => {
    expect(workerMode(env({ NODE_ENV: "development" }))).toBe("embedded");
    expect(workerMode(env({ NODE_ENV: "production" }))).toBe("external");
    expect(workerMode(env({ NODE_ENV: "development", VARDO_WORKER: "external" }))).toBe("external");
    expect(workerMode(env({ NODE_ENV: "production", VARDO_WORKER: "embedded" }))).toBe("embedded");
  });

  it("runs loops in web always when embedded and hands them off in production", () => {
    expect(loopsInWeb(env({ NODE_ENV: "development" }))).toBe("always");
    expect(loopsInWeb(env({ NODE_ENV: "production" }))).toBe("auto");
  });

  it("lets VARDO_LOOPS_IN_WEB override either default", () => {
    expect(loopsInWeb(env({ NODE_ENV: "development", VARDO_LOOPS_IN_WEB: "auto" }))).toBe("auto");
    expect(loopsInWeb(env({ NODE_ENV: "production", VARDO_LOOPS_IN_WEB: "always" }))).toBe("always");
    expect(loopsInWeb(env({ NODE_ENV: "production", VARDO_LOOPS_IN_WEB: "never" }))).toBe("never");
    expect(loopsInWeb(env({ NODE_ENV: "production", VARDO_LOOPS_IN_WEB: "bogus" }))).toBe("auto");
  });

  it("expects a worker unless web runs every loop", () => {
    expect(workerExpected(env({ NODE_ENV: "production" }))).toBe(true);
    expect(workerExpected(env({ NODE_ENV: "development" }))).toBe(false);
    expect(workerExpected(env({ NODE_ENV: "production", VARDO_LOOPS_IN_WEB: "always" }))).toBe(false);
  });

  it("starts web loops under pnpm dev only with VARDO_DEV_WORKERS=1", () => {
    expect(webLoopsEnabled(env({ NODE_ENV: "development" }))).toBe(false);
    expect(webLoopsEnabled(env({ NODE_ENV: "development", VARDO_DEV_WORKERS: "1" }))).toBe(true);
    expect(webLoopsEnabled(env({ NODE_ENV: "production" }))).toBe(true);
    expect(webLoopsEnabled(env({ NODE_ENV: "production", VARDO_DEV_WORKERS: "0" }))).toBe(true);
  });

  it("reads the drain budget and health port, falling back on junk", () => {
    expect(workerDrainMs(env({}))).toBe(540_000);
    expect(workerDrainMs(env({ VARDO_WORKER_DRAIN_SECONDS: "60" }))).toBe(60_000);
    expect(workerDrainMs(env({ VARDO_WORKER_DRAIN_SECONDS: "-1" }))).toBe(540_000);
    expect(workerHealthPort(env({}))).toBe(3001);
    expect(workerHealthPort(env({ VARDO_WORKER_HEALTH_PORT: "4001" }))).toBe(4001);
  });
});
