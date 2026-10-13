import { describe, it, expect } from "vitest";
import { knownFailure } from "@/lib/git-integration/deploy-failure";
import { healthFailureMessage } from "@/lib/docker/deploy-steps/swap";

// Fake credentials, built in parts so secret scanners don't flag them.
const CRED = ["u", "p"].join(":");
const TOKEN_CRED = ["x-access-token", "ghs_abc"].join(":");

describe("knownFailure", () => {
  it.each([
    ["nixpacks timed out after 2400s", "The build took longer than the 40 minute limit."],
    ["docker timed out after 300s", "The build took longer than the 5 minute limit."],
    ["docker failed (exit 1): #12 ERROR npm ci\nFailed step #12 output:\nnpm ERR! /srv/app", "Build failed (exit 1)."],
    ["railpack failed (exit null): ", "Build failed."],
    ["Deployment timed out after 45 minutes", "The deploy took longer than the 45 minute limit."],
    ["Pre-build/pre-pull for blue failed (old slot unaffected): The build ran out of memory (4 GiB) and was stopped", "The build ran out of memory."],
    ["Pre-build/pre-pull for green failed (old slot unaffected): Command failed: docker compose -f /var/vardo/apps/x/docker-compose.yml -p x pull web\nError: pull access denied for registry.internal:5000/x", "Couldn't pull the image."],
    ["Pre-build/pre-pull for green failed (old slot unaffected): Command failed: docker compose -f a.yml -p x build web\nboom", "The image build failed."],
    ["docker compose up (blue) failed: Command failed: docker compose up\nport 10.0.0.4:80 in use", "The containers failed to start."],
    ["Shared services failed to start: db exited", "Shared services failed to start."],
    ["Couldn't clone https://github.com/acme/private without a GitHub token: fatal: not found", "Couldn't clone the repository."],
    ["Command failed: git -C /var/vardo/apps/x fetch origin main", "Couldn't fetch the repository."],
    [`Command failed: docker volume create x\nDATABASE_URL=postgres://${CRED}@db/x`, "A command failed during the deploy."],
    ["Deployment aborted", "The deploy was stopped."],
    ["Cancelled", "The deploy was cancelled."],
    [
      "Rollback target commit 3bed1769abcdef0123456789abcdef0123456789 is not available in the repository — the branch may have been force-pushed or the commit garbage collected",
      "The commit is no longer in the repository. It may have been force-pushed away.",
    ],
    ["Deploy queue timeout — waited too long for a concurrency slot", "The deploy waited too long for a free deploy slot and didn't start."],
    ["Deploy cancelled while waiting in concurrency queue", "The deploy was cancelled while it waited in the queue."],
    ["Deploy was removed from the concurrency queue before it started", "The deploy was taken out of the queue before it started."],
    ["Vardo is restarting to finish an update — retry the deploy in a minute", "Vardo was restarting for an update, so the deploy didn't start. Retry it in a minute."],
    ["Deployment never started — the process that queued it stopped and was cancelled", "The deploy was cancelled before it started."],
    ["Deployment was stuck in the queue for 90 minutes and was cancelled", "The deploy waited in the queue longer than 90 minutes and was cancelled."],
    ["Rolled back after the deploy", "The new version stopped soon after going live."],
  ])("maps %j", (raw, expected) => {
    expect(knownFailure(raw)).toBe(expected);
  });

  it("maps every health failure the swap step raises", () => {
    const waitedMs = 61_000;
    expect(knownFailure(healthFailureMessage({ kind: "crashed", service: "web", detail: "exit 137" } as never, "blue")))
      .toBe("The new version crashed before passing its health check.");
    expect(knownFailure(healthFailureMessage({ kind: "unhealthy", service: "web", waitedMs } as never, "blue")))
      .toBe("The new version failed its health check.");
    expect(knownFailure(healthFailureMessage({ kind: "starting", service: "web", waitedMs } as never, "blue")))
      .toBe("The new version was still starting when its health check timed out.");
    expect(knownFailure(healthFailureMessage({ kind: "not-ready", detail: "tcp 10.0.0.9:3000 refused", waitedMs } as never, "green")))
      .toBe("The new version didn't become ready in time.");
  });

  it("returns null for unknown or empty errors", () => {
    expect(knownFailure("Previews are disabled on this instance")).toBeNull();
    expect(knownFailure("")).toBeNull();
    expect(knownFailure(null)).toBeNull();
  });

  it("never carries stderr, hosts, IPs, paths or env into the text", () => {
    const leaky = [
      "docker failed (exit 1): ERROR at /home/app/src/index.ts 192.168.1.5 SECRET_KEY=abc",
      "nixpacks timed out after 600s /srv/build",
      "docker compose up (blue) failed: bind 10.0.0.4:443 vardo.internal TOKEN=xyz",
      "Pre-build/pre-pull for blue failed (old slot unaffected): Command failed: docker compose -f /opt/x.yml pull\nunauthorized registry.example.com",
      `Command failed: git clone https://${TOKEN_CRED}@github.com/acme/x /var/vardo`,
    ];
    for (const raw of leaky) {
      const text = knownFailure(raw)!;
      expect(text).not.toBeNull();
      expect(text).not.toMatch(/\/|\d+\.\d+\.\d+\.\d+|=|\.internal|\.com|ERROR|unauthorized|ghs_/);
    }
  });
});
