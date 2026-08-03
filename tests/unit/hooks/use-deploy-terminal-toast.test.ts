import { describe, it, expect } from "vitest";
import { terminalMessage, NOT_A_FAULT } from "@/app/(authenticated)/apps/[...slug]/hooks/use-deploy";

// ---------------------------------------------------------------------------
// Deploy done event — what the user is told
//
// The done payload now carries status and error. Before that every unsuccessful
// deploy toasted "Deployment failed", including a supersede the user caused by
// deploying again.
// ---------------------------------------------------------------------------

describe("terminalMessage", () => {
  it("prefers the engine's error message", () => {
    expect(terminalMessage("failed", "green slot did not become healthy")).toBe(
      "green slot did not become healthy",
    );
  });

  it("names a supersede rather than calling it a failure", () => {
    expect(terminalMessage("superseded")).toBe("Superseded by a newer deploy");
  });

  it("names a cancel", () => {
    expect(terminalMessage("cancelled")).toBe("Deployment cancelled");
  });

  it("falls back for a failure with no message", () => {
    expect(terminalMessage("failed")).toBe("Deployment failed");
    expect(terminalMessage()).toBe("Deployment failed");
  });
});

describe("NOT_A_FAULT", () => {
  it("covers the outcomes the user caused", () => {
    expect(NOT_A_FAULT.has("cancelled")).toBe(true);
    expect(NOT_A_FAULT.has("superseded")).toBe(true);
  });

  it("leaves a real failure as an error", () => {
    expect(NOT_A_FAULT.has("failed")).toBe(false);
    expect(NOT_A_FAULT.has("rolled_back")).toBe(false);
  });
});
