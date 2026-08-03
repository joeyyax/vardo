import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// SAFE_CANCEL_STAGES — which phases a cancel or supersede may interrupt
//
// The image build lives in its own stage now. While it runs nothing has been
// stopped and nothing new is serving, so a cancel there is free — previously it
// fell inside "deploy" and was refused for the ~3 minutes the build took.
// ---------------------------------------------------------------------------

vi.mock("@/lib/redis", () => ({ redis: {} }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/docker/deploy", () => ({ createDeployment: vi.fn(), runDeployment: vi.fn() }));

import { SAFE_CANCEL_STAGES } from "@/lib/docker/deploy-cancel";

describe("SAFE_CANCEL_STAGES", () => {
  it("covers everything up to and including the image build", () => {
    expect([...SAFE_CANCEL_STAGES].sort()).toEqual(["build", "clone", "compose"]);
  });

  it("excludes every stage that has touched a container", () => {
    for (const stage of ["deploy", "healthcheck", "routing", "cleanup", "done"]) {
      expect(SAFE_CANCEL_STAGES.has(stage as never)).toBe(false);
    }
  });
});
