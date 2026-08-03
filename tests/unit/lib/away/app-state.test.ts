import { describe, it, expect } from "vitest";

import {
  deriveAppStateFacts,
  DEPLOY_EXPLAINS_MS,
  type AwayAppRow,
  type AwayDeployRow,
} from "@/lib/away/app-state";

const SINCE = new Date("2026-07-29T20:00:00Z");
const DURING = new Date("2026-07-30T10:00:00Z");
const BEFORE = new Date("2026-07-28T10:00:00Z");

function app(overrides: Partial<AwayAppRow> = {}): AwayAppRow {
  return {
    id: "app-1",
    name: "paperless",
    displayName: "Paperless",
    status: "active",
    parked: false,
    containerStartedAt: null,
    updatedAt: BEFORE,
    ...overrides,
  };
}

function deploy(overrides: Partial<AwayDeployRow> = {}): AwayDeployRow {
  return { appId: "app-1", status: "success", startedAt: DURING, ...overrides };
}

describe("deriveAppStateFacts — unexplained state", () => {
  it("flags an app that went missing with no deploy behind it", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "missing", updatedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("app.down-unexplained");
    expect(facts[0].outcome).toBe("failure");
  });

  it("treats an error state the same as missing", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "error", updatedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.down-unexplained");
  });

  it("separates a plain stop from an outage", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "stopped", updatedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.stopped-unexplained");
  });

  it("says nothing about a parked app being off", () => {
    expect(
      deriveAppStateFacts(
        [
          app({ status: "stopped", parked: true, updatedAt: DURING }),
          app({ id: "app-2", status: "missing", parked: true, updatedAt: DURING }),
        ],
        [],
        SINCE,
      ),
    ).toEqual([]);
  });

  it("still reports a parked app coming back up on its own", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "active", parked: true, containerStartedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.restarted-unexplained");
  });

  it("ignores a bad state that predates the window", () => {
    const facts = deriveAppStateFacts([app({ status: "missing" })], [], SINCE);
    expect(facts).toHaveLength(0);
  });

  it("links to the app so the row is actionable", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "missing", updatedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts[0].href).toBe("/apps/paperless");
  });
});

describe("deriveAppStateFacts — explained state", () => {
  it("says nothing when a failed deploy already reports the outage", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "error", updatedAt: DURING })],
      [deploy({ status: "failed" })],
      SINCE,
    );
    expect(facts).toHaveLength(0);
  });

  it("flags an app that broke after its deploy succeeded", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "error", updatedAt: DURING })],
      [deploy({ status: "success" })],
      SINCE,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("app.broke-after-deploy");
  });

  it("stays quiet when a slot stops after a good deploy", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "stopped", updatedAt: DURING })],
      [deploy({ status: "success" })],
      SINCE,
    );
    expect(facts).toHaveLength(0);
  });

  it("stays quiet when a cancelled deploy accounts for the state", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "stopped", updatedAt: DURING })],
      [deploy({ status: "cancelled" })],
      SINCE,
    );
    expect(facts).toHaveLength(0);
  });

  it("skips an app mid-deploy", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "deploying", updatedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts).toHaveLength(0);
  });

  it("judges each app against its own deploys", () => {
    const facts = deriveAppStateFacts(
      [
        app({ status: "missing", updatedAt: DURING }),
        app({ id: "app-2", name: "immich", status: "error", updatedAt: DURING }),
      ],
      [deploy({ appId: "app-2", status: "failed" })],
      SINCE,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].subjectId).toBe("app-1");
  });
});

describe("deriveAppStateFacts — restarts", () => {
  it("calls a restart shortly after a deploy expected", () => {
    const started = new Date(DURING.getTime() + 60_000);
    const facts = deriveAppStateFacts(
      [app({ containerStartedAt: started })],
      [deploy({ startedAt: DURING })],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.restart-expected");
    expect(facts[0].outcome).toBe("neutral");
  });

  it("calls a restart with no deploy near it unexplained", () => {
    const facts = deriveAppStateFacts(
      [app({ containerStartedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.restarted-unexplained");
  });

  it("stops crediting a deploy once it is too far in the past", () => {
    const started = new Date(DURING.getTime() + DEPLOY_EXPLAINS_MS + 1000);
    const facts = deriveAppStateFacts(
      [app({ containerStartedAt: started })],
      [deploy({ startedAt: DURING })],
      SINCE,
    );
    expect(facts[0].kind).toBe("app.restarted-unexplained");
  });

  it("ignores a container that has been up since before the window", () => {
    const facts = deriveAppStateFacts(
      [app({ containerStartedAt: BEFORE })],
      [],
      SINCE,
    );
    expect(facts).toHaveLength(0);
  });

  it("reports the outage rather than the restart when both apply", () => {
    const facts = deriveAppStateFacts(
      [app({ status: "error", updatedAt: DURING, containerStartedAt: DURING })],
      [],
      SINCE,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("app.down-unexplained");
  });
});
