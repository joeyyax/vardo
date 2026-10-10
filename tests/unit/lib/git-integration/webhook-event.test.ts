// A relay event carries identifiers only: no code, commit text, credentials or commands.

import { describe, it, expect } from "vitest";
import {
  eventFromGithub,
  MAX_RELAY_RAW_BYTES,
  relayEventSchema,
  toRelayEvent,
} from "@/lib/git-integration/webhook-event";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const push = {
  ref: "refs/heads/main",
  after: SHA,
  repository: {
    full_name: "acme/site",
    clone_url: "https://x-access-token:ghs_secret@github.com/acme/site.git",
  },
  head_commit: { message: "rotate the database password to hunter2", modified: ["db.env"] },
  commits: [{ id: SHA, message: "rotate", added: ["secrets.txt"] }],
  pusher: { name: "dev", email: "dev@example.com" },
  installation: { id: 2 },
};

const ALLOWED_KEYS = ["v", "relayed", "deliveryId", "event", "repoFullName", "cloneUrls", "ref", "branch", "headSha", "pullRequest", "github"];

describe("relay payload", () => {
  const event = eventFromGithub("push", push, "d-1")!;
  const relay = toRelayEvent({ ...event, deliveryId: "d-1" });

  it("carries only the listed identifiers", () => {
    expect(Object.keys(relay).every((k) => ALLOWED_KEYS.includes(k))).toBe(true);
    expect(relay).toEqual({
      v: 1,
      relayed: true,
      deliveryId: "d-1",
      event: "push",
      repoFullName: "acme/site",
      cloneUrls: { https: "https://github.com/acme/site.git", ssh: "git@github.com:acme/site.git" },
      ref: "refs/heads/main",
      branch: "main",
      headSha: SHA,
    });
  });

  it("leaves out commit text, file lists, emails, tokens and the installation", () => {
    const text = JSON.stringify(relay);
    for (const leaked of ["hunter2", "db.env", "secrets.txt", "dev@example.com", "ghs_secret", "x-access-token", "installation"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("passes its own schema", () => {
    expect(relayEventSchema.safeParse(relay).success).toBe(true);
  });

  it("drops GitHub's body when it's too large to carry", () => {
    const big = toRelayEvent({ ...event, deliveryId: "d-1" }, { body: "x".repeat(MAX_RELAY_RAW_BYTES + 1), signature: `sha256=${"0".repeat(64)}` });
    expect(big.github).toBeUndefined();
  });
});

describe("relay schema", () => {
  const relay = toRelayEvent({ ...eventFromGithub("push", push, "d-1")!, deliveryId: "d-1" });

  it.each([
    ["an extra command field", { ...relay, command: "rm -rf /" }],
    ["env vars", { ...relay, env: { TOKEN: "x" } }],
    ["credentials in a clone URL", { ...relay, cloneUrls: { ...relay.cloneUrls, https: "https://u:p@github.com/acme/site.git" } }],
    ["a clone URL for another repo", { ...relay, cloneUrls: { ...relay.cloneUrls, https: "https://evil.example.com/acme/site.git" } }],
    ["a branch that reads as an option", { ...relay, branch: "--upload-pack=x", ref: "refs/heads/--upload-pack=x" }],
    ["a ref that disagrees with the branch", { ...relay, ref: "refs/heads/other" }],
    ["a non-hex SHA", { ...relay, headSha: "HEAD~1" }],
    ["an unmarked event", { ...relay, relayed: false }],
    ["pull request details on a push", { ...relay, pullRequest: { number: 1, action: "opened", headRepoFullName: null, headIsFork: null, author: null } }],
  ])("rejects %s", (_label, payload) => {
    expect(relayEventSchema.safeParse(payload).success).toBe(false);
  });
});
