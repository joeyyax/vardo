import { describe, it, expect, vi } from "vitest";

// The tail turns wait entries into waits, from the queue onward, and never hands them over as log lines.

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
  readStream: async function* () {
    yield { id: "100-0", fields: { line: "[wait] deploy-slot (1 ahead)", stage: "queued", status: "running", wait: "deploy-slot", ahead: "1", total: "4" } };
    yield { id: "101-0", fields: { line: "[wait] done", stage: "queued", status: "running", wait: "" } };
    yield { id: "102-0", fields: { line: "[stage] build: running", stage: "build", status: "running" } };
    yield { id: "103-0", fields: { line: "[wait] build-slot", stage: "build", status: "running", wait: "build-slot" } };
    yield { id: "104-0", fields: { line: "[queue] Waiting for the builder: 1 running, 1 at a time", stage: "build", status: "running" } };
    yield { id: "105-0", fields: { line: "[wait] done", stage: "build", status: "running", wait: "" } };
    state.status = "success";
    yield { id: "106-0", fields: { line: "[stage] done: success", stage: "done", status: "success" } };
  },
}));

const { tailDeployment } = await import("@/lib/stream/deploy-tail");

describe("tailDeployment waits", () => {
  it("reads waits from the queue on, with their stream ids, and keeps them out of the log", async () => {
    const waits: unknown[] = [];
    const lines: string[] = [];
    const notes: string[] = [];
    const result = await tailDeployment(
      "d1",
      { onLog: (line) => lines.push(line), onStage: () => {}, onWait: (w) => waits.push(w), onWaiting: (m) => notes.push(m) },
      { pollMs: 5 },
    );

    expect(result?.status).toBe("success");
    expect(waits).toEqual([
      { reason: "deploy-slot", ahead: 1, total: 4, streamId: "100-0" },
      { reason: null, streamId: "101-0" },
      { reason: "build-slot", streamId: "103-0" },
      { reason: null, streamId: "105-0" },
    ]);
    expect(lines).toEqual(["[queue] Waiting for the builder: 1 running, 1 at a time"]);
    expect(notes).toEqual(["Waiting for a free deploy slot (2 of 4)", "Waiting for the builder"]);
  });
});
