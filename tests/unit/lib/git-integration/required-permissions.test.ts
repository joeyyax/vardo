import { describe, it, expect } from "vitest";
import {
  appIssue,
  appPermissionsUrl,
  awaitingApproval,
  covers,
  installationIssue,
  installationUrl,
  missingFromApp,
} from "@/lib/git-integration/required-permissions";

const FULL = { metadata: "read", contents: "read", pull_requests: "write", deployments: "write", statuses: "write" };
const ids = (perms: { id: string }[]) => perms.map((p) => p.id);

describe("permission levels", () => {
  it("write and admin cover read; read doesn't cover write", () => {
    expect(covers("write", "read")).toBe(true);
    expect(covers("admin", "write")).toBe(true);
    expect(covers("read", "write")).toBe(false);
    expect(covers(undefined, "read")).toBe(false);
  });
});

describe("app-level diff", () => {
  it("reports what the App doesn't ask for", () => {
    const app = { metadata: "read", contents: "read", pull_requests: "write" };
    expect(ids(missingFromApp(app))).toEqual(["deployments", "statuses"]);
  });

  it("counts a read grant short of a write requirement", () => {
    expect(ids(missingFromApp({ ...FULL, statuses: "read" }))).toEqual(["statuses"]);
  });

  it("is empty when the App asks for everything", () => {
    expect(missingFromApp(FULL)).toEqual([]);
  });
});

describe("installation-level diff", () => {
  it("reports what the App asks for that the installation hasn't accepted", () => {
    const inst = { metadata: "read", contents: "read", pull_requests: "write" };
    expect(ids(awaitingApproval(FULL, inst))).toEqual(["deployments", "statuses"]);
  });

  it("leaves out what the App itself lacks, so only the owner is asked", () => {
    const app = { ...FULL, deployments: undefined };
    const inst = { metadata: "read", contents: "read", pull_requests: "write" };
    expect(ids(awaitingApproval(app, inst))).toEqual(["statuses"]);
    expect(ids(missingFromApp(app))).toEqual(["deployments"]);
  });

  it("is empty once the installation accepted", () => {
    expect(awaitingApproval(FULL, FULL)).toEqual([]);
  });
});

describe("fix URLs", () => {
  it("links a user-owned App to personal settings", () => {
    expect(appPermissionsUrl("acme-vardo", { login: "jdoe", type: "User" })).toBe(
      "https://github.com/settings/apps/acme-vardo/permissions",
    );
  });

  it("links an org-owned App to the org's settings", () => {
    expect(appPermissionsUrl("acme-vardo", { login: "acme", type: "Organization" })).toBe(
      "https://github.com/organizations/acme/settings/apps/acme-vardo/permissions",
    );
  });

  it("links a user installation to personal settings", () => {
    expect(installationUrl(42, { login: "jdoe", type: "User" })).toBe("https://github.com/settings/installations/42");
  });

  it("links an org installation to the org's settings", () => {
    expect(installationUrl(42, { login: "acme", type: "Organization" })).toBe(
      "https://github.com/organizations/acme/settings/installations/42",
    );
  });
});

describe("issues", () => {
  it("builds an installation issue with features and the approval link", () => {
    const issue = installationIssue(42, { login: "acme", type: "Organization" }, awaitingApproval(FULL, { metadata: "read", contents: "read", pull_requests: "write" }));
    expect(issue).toMatchObject({
      key: "github:installation:42",
      provider: "github",
      scope: { kind: "installation", id: "42", account: "acme" },
      fixUrl: "https://github.com/organizations/acme/settings/installations/42",
      features: ["Deployments on GitHub", "Commit status checks"],
      purposes: ["show deploy progress on pull requests"],
    });
  });

  it("returns null when nothing is missing", () => {
    expect(appIssue("acme-vardo", { login: "acme", type: "Organization" }, [])).toBeNull();
  });
});
