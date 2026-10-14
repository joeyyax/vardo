import { describe, it, expect, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { status: "queued" } }));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ status: state.status, log: "", durationMs: 0, postDeployError: null }] }),
    }),
  },
}));
vi.mock("@/lib/stream/consumer", () => ({
  readStream: async function* (_key: string, opts: { signal: AbortSignal }) {
    await new Promise((resolve) => opts.signal.addEventListener("abort", resolve, { once: true }));
  },
}));

const { tailDeployment } = await import("@/lib/stream/deploy-tail");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tailDeployment status", () => {
  it("reports queued, running and a requeue once each", async () => {
    state.status = "queued";
    const statuses: string[] = [];
    const tail = tailDeployment(
      "d1",
      { onLog: () => {}, onStage: () => {}, onStatus: (s) => statuses.push(s) },
      { pollMs: 5 },
    );

    await wait(30);
    state.status = "running";
    await wait(40);
    state.status = "queued";
    await wait(40);
    state.status = "running";
    await wait(40);
    state.status = "success";

    const result = await tail;
    expect(result?.status).toBe("success");
    expect(statuses).toEqual(["queued", "running", "queued", "running"]);
  });

  it("reports running alone for a deploy already claimed", async () => {
    state.status = "running";
    const statuses: string[] = [];
    const tail = tailDeployment(
      "d2",
      { onLog: () => {}, onStage: () => {}, onStatus: (s) => statuses.push(s) },
      { pollMs: 5 },
    );
    await wait(30);
    state.status = "failed";
    await tail;
    expect(statuses).toEqual(["running"]);
  });
});
