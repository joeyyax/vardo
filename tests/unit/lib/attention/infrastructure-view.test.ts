import { describe, it, expect } from "vitest";

import {
  applyInfrastructureFailure,
  applyInfrastructurePayload,
  INFRA_FAILURES_BEFORE_UNREACHABLE,
  INFRA_POLL_ACTIVE_MS,
  INFRA_POLL_IDLE_MS,
  INFRA_RESOLVED_MS,
  infrastructurePollMs,
  infrastructureViewRows,
  initialInfrastructureView,
  type InfrastructureView,
} from "@/lib/attention/infrastructure-view";
import { SELF_DEPLOY_ROW_KEY } from "@/lib/attention/infrastructure-rows";
import type { AttentionRow } from "@/lib/ui/attention";

const NOW = Date.UTC(2026, 7, 1, 10, 0, 0);

const deployingRow: AttentionRow = {
  key: SELF_DEPLOY_ROW_KEY,
  label: "Vardo updating",
  tone: "activity",
  items: [{ id: "deploy-1", name: "Vardo" }],
};

const healthy = { rows: [], selfDeploy: false };
const deploying = { rows: [deployingRow], selfDeploy: true };

function failTimes(state: InfrastructureView, times: number): InfrastructureView {
  let next = state;
  for (let i = 0; i < times; i++) next = applyInfrastructureFailure(next);
  return next;
}

describe("infrastructure view", () => {
  it("renders nothing on a healthy instance", () => {
    const state = applyInfrastructurePayload(initialInfrastructureView(), healthy, NOW);

    expect(infrastructureViewRows(state, NOW)).toEqual([]);
    expect(infrastructurePollMs(state)).toBe(INFRA_POLL_IDLE_MS);
  });

  it("polls faster while a self-deploy is running", () => {
    const state = applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW);

    expect(infrastructureViewRows(state, NOW)).toEqual([deployingRow]);
    expect(infrastructurePollMs(state)).toBe(INFRA_POLL_ACTIVE_MS);
  });

  it("holds the last rows through a blip rather than blanking the bar", () => {
    const state = failTimes(
      applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW),
      INFRA_FAILURES_BEFORE_UNREACHABLE - 1,
    );

    expect(infrastructureViewRows(state, NOW)).toEqual([deployingRow]);
  });

  it("calls the gap a restart when the instance was mid self-deploy", () => {
    const state = failTimes(
      applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW),
      INFRA_FAILURES_BEFORE_UNREACHABLE,
    );
    const rows = infrastructureViewRows(state, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "vardo-restarting", tone: "activity" });
  });

  it("calls the gap an outage when nothing was deploying", () => {
    const state = failTimes(
      applyInfrastructurePayload(initialInfrastructureView(), healthy, NOW),
      INFRA_FAILURES_BEFORE_UNREACHABLE,
    );
    const rows = infrastructureViewRows(state, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "vardo-unreachable", tone: "error" });
  });

  it("drops stale rows once the instance stops answering", () => {
    const stale: AttentionRow = {
      key: "core-service-down",
      label: "Core service down",
      tone: "error",
      items: [{ id: "loki", name: "Loki" }],
    };
    const state = failTimes(
      applyInfrastructurePayload(initialInfrastructureView(), { rows: [stale], selfDeploy: false }, NOW),
      INFRA_FAILURES_BEFORE_UNREACHABLE,
    );

    expect(infrastructureViewRows(state, NOW).map((r) => r.key)).toEqual(["vardo-unreachable"]);
  });

  it("resolves a self-deploy visibly once the new instance answers", () => {
    const restarting = failTimes(
      applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW),
      INFRA_FAILURES_BEFORE_UNREACHABLE,
    );
    const back = applyInfrastructurePayload(restarting, healthy, NOW + 30_000);

    expect(back.failures).toBe(0);
    expect(back.resolvedAt).toBe(NOW + 30_000);
    expect(infrastructureViewRows(back, NOW + 30_000).map((r) => r.key)).toEqual(["vardo-updated"]);
  });

  it("clears the resolved notice on its own", () => {
    const back = applyInfrastructurePayload(
      applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW),
      healthy,
      NOW,
    );

    expect(infrastructureViewRows(back, NOW + INFRA_RESOLVED_MS)).toEqual([]);
    expect(infrastructurePollMs(back)).toBe(INFRA_POLL_ACTIVE_MS);
  });

  it("does not claim a resolution nobody was waiting for", () => {
    const state = applyInfrastructurePayload(initialInfrastructureView(), healthy, NOW);

    expect(state.resolvedAt).toBeNull();
    expect(infrastructureViewRows(state, NOW)).toEqual([]);
  });

  it("drops a pending resolution when the next deploy starts", () => {
    const resolved = applyInfrastructurePayload(
      applyInfrastructurePayload(initialInfrastructureView(), deploying, NOW),
      healthy,
      NOW,
    );
    const again = applyInfrastructurePayload(resolved, deploying, NOW + 1_000);

    expect(again.resolvedAt).toBeNull();
    expect(infrastructureViewRows(again, NOW + 1_000).map((r) => r.key)).toEqual([
      SELF_DEPLOY_ROW_KEY,
    ]);
  });
});
