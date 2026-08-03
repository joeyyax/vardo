import { describe, it, expect } from "vitest";

import {
  ALL_FAMILIES,
  classify,
  errorTextFrom,
  familyFor,
  outcomeFor,
} from "@/lib/activity/taxonomy";
import {
  activityFamilyEnum,
  activityOutcomeEnum,
} from "@/lib/db/schema/enums";
import type { ActivityRow } from "@/lib/activity/types";

function row(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "a1",
    action: "deployment.succeeded",
    metadata: null,
    createdAt: new Date("2026-07-31T10:00:00Z"),
    user: null,
    app: { id: "app-1", name: "paperless", displayName: "Paperless" },
    ...overrides,
  };
}

// recordActivity writes these straight into the columns, so a family the
// database has never heard of fails the insert.
describe("database enums", () => {
  it("covers every family", () => {
    expect([...activityFamilyEnum.enumValues].sort()).toEqual(
      [...ALL_FAMILIES].sort()
    );
  });

  it("covers every outcome", () => {
    expect([...activityOutcomeEnum.enumValues].sort()).toEqual([
      "failure",
      "neutral",
      "success",
    ]);
  });
});

describe("familyFor", () => {
  it("maps deployment actions to deploy", () => {
    expect(familyFor("deployment.failed")).toBe("deploy");
  });

  it("maps app and volume actions to app", () => {
    expect(familyFor("app.created")).toBe("app");
    expect(familyFor("volume.drift_detected")).toBe("app");
  });

  it("treats privilege toggles as security, not org", () => {
    expect(familyFor("project.allow_docker_socket.updated")).toBe("security");
    expect(familyFor("project.allow_bind_mounts.updated")).toBe("security");
    expect(familyFor("org.trusted_changed")).toBe("security");
    expect(familyFor("deploy_key.created")).toBe("security");
  });

  it("keeps ordinary project and transfer actions in org", () => {
    expect(familyFor("project.renamed")).toBe("org");
    expect(familyFor("transfer.initiated")).toBe("org");
  });

  it("falls back to org for unrecognized actions", () => {
    expect(familyFor("something.weird")).toBe("org");
  });
});

describe("outcomeFor", () => {
  it("reads failure and success from the action suffix", () => {
    expect(outcomeFor("deployment.failed")).toBe("failure");
    expect(outcomeFor("deployment.succeeded")).toBe("success");
    expect(outcomeFor("backup.failed")).toBe("failure");
  });

  it("calls an automatic rollback a failure", () => {
    expect(outcomeFor("deployment.rolled_back")).toBe("failure");
  });

  it("calls a deliberate instant rollback neutral", () => {
    expect(outcomeFor("deployment.instant_rollback")).toBe("neutral");
  });

  it("calls a cancelled deploy neutral rather than failed", () => {
    expect(outcomeFor("deployment.cancelled")).toBe("neutral");
  });

  it("treats detected drift as a failure", () => {
    expect(outcomeFor("volume.drift_detected")).toBe("failure");
  });

  it("sorts the stability events its suffixes would get wrong", () => {
    expect(outcomeFor("app.crashed")).toBe("failure");
    expect(outcomeFor("app.crash_looping")).toBe("failure");
    expect(outcomeFor("app.recovered")).toBe("success");
  });

  it("defaults to neutral", () => {
    expect(outcomeFor("app.created")).toBe("neutral");
  });
});

describe("errorTextFrom", () => {
  it("reads the error key deployment.failed writes", () => {
    expect(errorTextFrom({ deploymentId: "d1", error: "exit code 1" })).toBe(
      "exit code 1"
    );
  });

  it("falls back to the reason key an automatic rollback writes", () => {
    expect(errorTextFrom({ reason: "Container crashed" })).toBe(
      "Container crashed"
    );
  });

  it("keeps only the first line", () => {
    expect(errorTextFrom({ error: "build failed\n  at step 3\n  npm ERR" })).toBe(
      "build failed"
    );
  });

  it("ignores blank and non-string values", () => {
    expect(errorTextFrom({ error: "   ", reason: 42 })).toBeUndefined();
    expect(errorTextFrom(null)).toBeUndefined();
    expect(errorTextFrom("not an object")).toBeUndefined();
  });
});

describe("classify", () => {
  it("prefers the stored family and outcome over the action string", () => {
    const item = classify(
      row({ action: "app.created", family: "security", outcome: "failure" })
    );
    expect(item.family).toBe("security");
    expect(item.outcome).toBe("failure");
  });

  it("derives family and outcome for rows written before the columns", () => {
    const item = classify(row({ action: "deployment.failed" }));
    expect(item.family).toBe("deploy");
    expect(item.outcome).toBe("failure");
  });

  it("attaches an error only to failures", () => {
    const failed = classify(
      row({ action: "deployment.failed", metadata: { error: "boom" } })
    );
    expect(failed.error).toBe("boom");

    const ok = classify(
      row({ action: "deployment.succeeded", metadata: { error: "boom" } })
    );
    expect(ok.error).toBeUndefined();
  });

  it("uses the app id as the subject when one is present", () => {
    expect(classify(row()).subjectId).toBe("app-1");
    expect(classify(row()).subjectLabel).toBe("Paperless");
  });

  it("keeps two deleted apps apart even though neither carries an appId", () => {
    const first = classify(
      row({ action: "app.deleted", app: null, metadata: { name: "grafana" } })
    );
    const second = classify(
      row({ action: "app.deleted", app: null, metadata: { name: "immich" } })
    );

    expect(first.subjectId).not.toBe(second.subjectId);
    expect(first.subjectLabel).toBe("grafana");
    expect(second.subjectLabel).toBe("immich");
  });

  it("falls back to a readable action when nothing names the subject", () => {
    const item = classify(
      row({ action: "org.trusted_changed", app: null, metadata: { trusted: true } })
    );
    expect(item.subjectLabel).toBe("Org trusted changed");
  });
});
