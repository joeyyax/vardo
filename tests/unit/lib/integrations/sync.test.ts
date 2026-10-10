import { describe, it, expect, vi, afterEach } from "vitest";
import { issueCopy, type IntegrationIssue, type RaisedIssue } from "@/lib/integrations/issues";
import { createRechecker, syncIssues, type IssueStore, type OpenIssue, type StoredIssue } from "@/lib/integrations/sync";

function memoryStore() {
  const rows = new Map<string, OpenIssue & { cleared: boolean }>();
  const k = (org: string, about: string) => `${org}|${about}`;
  const store: IssueStore = {
    listOpen: async () => [...rows.values()].filter((r) => !r.cleared).map(({ organizationId, about, detail }) => ({ organizationId, about, detail })),
    open: async (organizationId: string, detail: StoredIssue) => {
      rows.set(k(organizationId, detail.issue.key), { organizationId, about: detail.issue.key, detail, cleared: false });
      return true;
    },
    close: async (organizationId: string, abouts: string[]) => {
      for (const a of abouts) {
        const row = rows.get(k(organizationId, a));
        if (row) row.cleared = true;
      }
    },
  };
  return { store, rows };
}

function issue(over: Partial<IntegrationIssue> = {}): IntegrationIssue {
  return {
    key: "github:installation:42",
    provider: "github",
    scope: { kind: "installation", id: "42", account: "acme" },
    missing: [
      { id: "deployments", label: "Deployments", access: "write" },
      { id: "statuses", label: "Commit statuses", access: "write" },
    ],
    fixUrl: "https://github.com/organizations/acme/settings/installations/42",
    features: ["Deployments on GitHub", "Commit status checks"],
    purposes: ["show deploy progress on pull requests"],
    ...over,
  };
}

const raise = (i: IntegrationIssue, orgs = ["org-1"]): RaisedIssue => ({ issue: i, organizationIds: orgs });

function harness() {
  const mem = memoryStore();
  const notify = vi.fn();
  const approved = vi.fn(async () => {});
  return { ...mem, notify, approved, deps: { store: mem.store, notify, approved } };
}

describe("syncIssues", () => {
  it("notifies once per problem, not on every check", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue())], h.deps);
    await syncIssues("github", [raise(issue())], h.deps);
    await syncIssues("github", [raise(issue())], h.deps);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith("org-1", expect.objectContaining({ key: "github:installation:42" }));
  });

  it("notifies each org that hears about the problem once", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue(), ["org-1", "org-2", "org-1"])], h.deps);
    expect(h.notify.mock.calls.map((c) => c[0]).sort()).toEqual(["org-1", "org-2"]);
  });

  it("notifies again when the problem changes", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue())], h.deps);
    await syncIssues("github", [raise(issue({ missing: [{ id: "statuses", label: "Commit statuses", access: "write" }] }))], h.deps);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("clears a fixed problem and reports the approval once", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue())], h.deps);
    const result = await syncIssues("github", [], h.deps);
    expect(result.resolved.map((r) => r.about)).toEqual(["github:installation:42"]);
    expect(h.approved).toHaveBeenCalledTimes(1);
    expect(h.approved).toHaveBeenCalledWith("org-1", [expect.objectContaining({ key: "github:installation:42" })]);
    expect(await h.store.listOpen()).toEqual([]);

    await syncIssues("github", [], h.deps);
    expect(h.approved).toHaveBeenCalledTimes(1);
  });

  it("holds the approval while another problem for the org is still open", async () => {
    const h = harness();
    const app = issue({ key: "github:app", scope: { kind: "app", name: "acme-vardo" }, fixUrl: "https://github.com/organizations/acme/settings/apps/acme-vardo/permissions" });
    await syncIssues("github", [raise(app)], h.deps);
    await syncIssues("github", [raise(issue())], h.deps);
    expect(h.approved).not.toHaveBeenCalled();
    await syncIssues("github", [], h.deps);
    expect(h.approved).toHaveBeenCalledTimes(1);
  });

  it("notifies again when a cleared problem comes back", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue())], h.deps);
    await syncIssues("github", [], h.deps);
    await syncIssues("github", [raise(issue())], h.deps);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("clears quietly when the integration isn't checked", async () => {
    const h = harness();
    await syncIssues("github", [raise(issue())], h.deps);
    await syncIssues("github", [], h.deps, { quiet: true });
    expect(await h.store.listOpen()).toEqual([]);
    expect(h.approved).not.toHaveBeenCalled();
  });

  it("leaves other providers' issues alone", async () => {
    const h = harness();
    await syncIssues("gitlab", [raise(issue({ key: "gitlab:app", provider: "gitlab" }))], h.deps);
    await syncIssues("github", [], h.deps);
    expect((await h.store.listOpen()).map((o) => o.about)).toEqual(["gitlab:app"]);
  });
});

describe("issueCopy", () => {
  it("asks the account to accept new permissions in plain words", () => {
    const copy = issueCopy(issue());
    expect(copy.title).toBe("GitHub needs one more approval");
    expect(copy.message).toBe(
      "Vardo's GitHub App now asks for Deployments and Commit statuses so it can show deploy progress on pull requests. Review and accept the new permissions for acme.",
    );
    expect(copy.degraded).toBe("Off until then: deployments on GitHub and commit status checks.");
    expect(copy.actionLabel).toBe("Review and accept");
  });

  it("asks the App's owner to add permissions", () => {
    const copy = issueCopy(issue({ key: "github:app", scope: { kind: "app", name: "acme-vardo" } }));
    expect(copy.title).toBe("GitHub App needs more permissions");
    expect(copy.actionLabel).toBe("Open App permissions");
  });
});

describe("createRechecker", () => {
  afterEach(() => vi.useRealTimers());

  it("folds a burst of refusals into one check after the delay", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const r = createRechecker({ run, minIntervalMs: 600_000, delayMs: 30_000 });
    r.request();
    r.request();
    r.request();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits out the minimum interval since the last check", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const r = createRechecker({ run, minIntervalMs: 600_000, delayMs: 30_000 });
    r.ran();
    r.request();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(570_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
