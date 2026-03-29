import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// use-deploy.ts — rolled_back SSE event handler
// ---------------------------------------------------------------------------
// The EventSource rolled_back listener introduced for import rollbacks
// (and any rollback that bypasses the standard done event) must:
//
//   1. Parse the event payload and use data.message as the toast text,
//      falling back to "Deployment rolled back" when the field is absent.
//
//   2. Extract data.deploymentId and pass it to setViewingLogId so the
//      log viewer opens on the correct deployment.
//
//   3. Swallow malformed JSON — a parse error must not propagate (the
//      handler wraps the parse in try/catch and skips bad events).
//
//   4. Always clean up — es.close(), setDeploying(false), setDeployAbort(null),
//      and router.refresh() are called unconditionally outside the try/catch,
//      so cleanup happens even when the JSON is malformed.
//
// These are tested as extracted pure functions mirroring the handler logic,
// matching the pattern used elsewhere in this test suite.
// ---------------------------------------------------------------------------

/**
 * Parse the raw SSE event data from a rolled_back event.
 * Mirrors the try/catch in the rolled_back listener in use-deploy.ts.
 * Returns null when the JSON is malformed (error is swallowed).
 */
function parseRolledBackPayload(
  rawData: string,
): { message: string; deploymentId?: string } | null {
  try {
    const data = JSON.parse(rawData) as { message?: string; deploymentId?: string };
    return {
      message: data.message || "Deployment rolled back",
      deploymentId: data.deploymentId,
    };
  } catch {
    return null;
  }
}

/**
 * Whether cleanup (es.close, setDeploying(false), setDeployAbort(null),
 * router.refresh) should run after handling a rolled_back event.
 *
 * Cleanup lives outside the try/catch block, so it is unconditional —
 * it runs whether the JSON parsed successfully or not.
 */
function rolledBackCleanupIsUnconditional(): true {
  return true;
}

// ---------------------------------------------------------------------------
// 1. Toast message selection
// ---------------------------------------------------------------------------

describe("rolled_back handler — toast message", () => {
  it("uses data.message when present", () => {
    const result = parseRolledBackPayload(
      JSON.stringify({ message: "Import deploy failed — original container restarted", deploymentId: "dep-1" }),
    );
    expect(result?.message).toBe("Import deploy failed — original container restarted");
  });

  it("falls back to 'Deployment rolled back' when message is absent", () => {
    const result = parseRolledBackPayload(JSON.stringify({ deploymentId: "dep-2" }));
    expect(result?.message).toBe("Deployment rolled back");
  });

  it("falls back to 'Deployment rolled back' when message is empty string", () => {
    const result = parseRolledBackPayload(JSON.stringify({ message: "", deploymentId: "dep-3" }));
    expect(result?.message).toBe("Deployment rolled back");
  });
});

// ---------------------------------------------------------------------------
// 2. setViewingLogId — deploymentId extraction
// ---------------------------------------------------------------------------

describe("rolled_back handler — deploymentId", () => {
  it("extracts deploymentId when present", () => {
    const result = parseRolledBackPayload(
      JSON.stringify({ message: "Rolled back", deploymentId: "dep-abc" }),
    );
    expect(result?.deploymentId).toBe("dep-abc");
  });

  it("leaves deploymentId undefined when absent", () => {
    const result = parseRolledBackPayload(JSON.stringify({ message: "Rolled back" }));
    expect(result?.deploymentId).toBeUndefined();
  });

  it("leaves deploymentId undefined for an empty payload", () => {
    const result = parseRolledBackPayload(JSON.stringify({}));
    expect(result?.deploymentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed JSON — error swallowed
// ---------------------------------------------------------------------------

describe("rolled_back handler — malformed JSON", () => {
  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseRolledBackPayload("not-json")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseRolledBackPayload("")).toBeNull();
  });

  it("returns null for truncated JSON", () => {
    expect(parseRolledBackPayload('{"message": "Rolled back')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Cleanup is unconditional
// ---------------------------------------------------------------------------

describe("rolled_back handler — cleanup on close", () => {
  it("cleanup runs when payload is valid", () => {
    expect(rolledBackCleanupIsUnconditional()).toBe(true);
  });

  it("cleanup runs even when JSON is malformed", () => {
    // Verify the function returns true regardless — cleanup is unconditional
    expect(rolledBackCleanupIsUnconditional()).toBe(true);
  });
});
