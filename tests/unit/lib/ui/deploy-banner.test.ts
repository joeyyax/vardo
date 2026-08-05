import { describe, it, expect } from "vitest";
import { deployFailureBanner } from "@/lib/ui/deploy-banner";

const failed = { id: "d3", status: "failed" };
const success = { id: "d2", status: "success" };
const running = { id: "d1", status: "running" };

describe("deployFailureBanner", () => {
  it("reports a crash when the app is down and a deploy failed", () => {
    expect(deployFailureBanner("error", [failed, success])).toEqual({
      variant: "crashed",
      deployment: failed,
    });
  });

  it("stays silent when the app is down with no failed deploy", () => {
    expect(deployFailureBanner("error", [success])).toBeNull();
  });

  it("reports a recovered failure when the latest deploy failed but the app still serves", () => {
    expect(deployFailureBanner("active", [failed, success])).toEqual({
      variant: "recovered",
      deployment: failed,
    });
  });

  it("stays silent once a later deploy succeeds", () => {
    expect(deployFailureBanner("active", [success, failed])).toBeNull();
  });

  it("stays silent while a new deploy is in flight", () => {
    expect(deployFailureBanner("active", [running, failed])).toBeNull();
  });

  it("stays silent for a stopped app", () => {
    expect(deployFailureBanner("stopped", [failed])).toBeNull();
  });

  it("stays silent with no deployments", () => {
    expect(deployFailureBanner("active", [])).toBeNull();
    expect(deployFailureBanner("error", [])).toBeNull();
  });
});
