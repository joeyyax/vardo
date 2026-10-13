import { describe, it, expect } from "vitest";
import type { BusEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { notificationMailBody, renderNotificationEmail } from "@/lib/email/notification-email";
import { notificationSubject, subjectLine } from "@/lib/email/subjects";
import { failureCause, stepName } from "@/lib/email/templates/deploy-facts";
import { lastCycle, servingBlock } from "@/lib/email/templates/deploy-failed";
import { firstDeployNote } from "@/lib/email/templates/deploy-success";
import { daemonReason } from "@/lib/email/templates/deploy-incomplete";
import { richText, type MailBlock } from "@/lib/email/templates/components";

function fixture<T extends BusEvent["type"]>(name: string): Extract<BusEvent, { type: T }> {
  return EMAIL_FIXTURES.find((f) => f.name === name)!.event as Extract<BusEvent, { type: T }>;
}

const DEPLOY_TYPES = new Set(["deploy.success", "deploy.failed", "deploy.incomplete", "deploy.rollback"]);
const text = (value: Parameters<typeof richText>[0] | undefined) => (value === undefined ? "" : richText(value));

describe("deploy failure cause", () => {
  const base = { message: "", failedStage: "healthcheck" };

  it("names the crashed service and how often it restarted", () => {
    const cause = failureCause({ ...base, errorMessage: "green slot did not become healthy: api crashed (crash-looping, 7 restarts). See logs above" });
    expect(cause.title).toBe("api crashed on start");
    expect(text(cause.body)).toBe("It restarted 7 times before Vardo gave up.");
  });

  it("adds the crash line when the log doesn't already show it", () => {
    const raw = "blue slot did not become healthy: api crashed (exit 1). See logs above";
    const shown = failureCause({ ...base, errorMessage: raw, crashReason: "Error: boom", logTail: ["api-1 | Error: boom"] });
    expect(shown.body).toBeUndefined();
    const hidden = failureCause({ ...base, errorMessage: raw, crashReason: "Error: boom", logTail: [] });
    expect(text(hidden.body)).toBe("Error: boom");
  });

  it("explains an unhealthy service and a slow start", () => {
    expect(failureCause({ ...base, errorMessage: "green slot did not become healthy: web healthcheck reports unhealthy after 90s. See logs above" })).toMatchObject({
      title: "web stayed unhealthy",
      body: "Its health check was still failing after 1 min 30 s.",
    });
    expect(failureCause({ ...base, errorMessage: "web is still starting after 120s (running, no restarts, logs still moving). Raise the app's health timeout" }).title).toBe(
      "web was still starting when the health check ran out of time",
    );
  });

  it("names the failed build step and leads with the commit", () => {
    const cause = failureCause({ ...fixture<"deploy.failed">("deploy-failed-build") });
    expect(cause.title).toBe("composer install failed");
    expect(text(cause.body)).toBe("9f8e7d6 Upgrade to PHP 8.4 didn't build. The step exited with code 2.");
    expect(cause.action?.href).toBe("https://github.com/acme/shop/commit/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432");
  });

  it("reuses the known-failure sentences", () => {
    expect(failureCause({ message: "", failedStage: "build", errorMessage: "The build ran out of memory (exit 137)" }).title).toBe("The build ran out of memory.");
  });

  it("falls back to the raw first line instead of guessing", () => {
    const cause = failureCause({ message: "", failedStage: "deploy", errorMessage: "Something odd happened. See logs above\nstderr: secret detail" });
    expect(cause.title).toBe("Something odd happened.");
    expect(cause.title).not.toContain("stderr");
  });

  it("drops flags and chained commands from a build step", () => {
    expect(stepName("composer install --no-dev --optimize-autoloader")).toBe("composer install");
    expect(stepName("npm ci && npm run build")).toBe("npm ci");
  });
});

describe("deploy failure email", () => {
  it("reassures only while a version still serves", () => {
    expect(servingBlock("previous")).toEqual({ kind: "reassure", strong: "Nothing is down.", text: "The previous version is still serving." });
    expect(servingBlock("new")?.kind).toBe("reassure");
    expect(servingBlock("none")).toEqual({ kind: "text", text: "Nothing is serving this app right now." });
    expect(servingBlock(undefined)).toBeUndefined();

    const down = notificationMailBody({ ...fixture<"deploy.failed">("deploy-failed"), serving: "none" }, FIXTURE_CONTEXT)!;
    expect(down.blocks?.some((b) => b.kind === "reassure")).toBe(false);
  });

  it("shows the commit once: in the callout for a build, in the facts otherwise", () => {
    const build = notificationMailBody(fixture("deploy-failed-build"), FIXTURE_CONTEXT)!;
    const facts = (b: MailBlock[] | undefined) => b?.flatMap((x) => (x.kind === "facts" ? x.facts.map((f) => f.label) : [])) ?? [];
    expect(facts(build.blocks)).not.toContain("Commit");
    const health = notificationMailBody({ ...fixture<"deploy.failed">("deploy-failed"), gitSha: "abcdef1234567" }, FIXTURE_CONTEXT)!;
    expect(facts(health.blocks)).toContain("Commit");
  });

  it("keeps a crash loop's last cycle and leaves short logs alone", () => {
    expect(lastCycle(["a 2026-10-09T17:02:11Z start", "err", "exit", "a 2026-10-09T17:02:19Z start", "err", "exit"])).toEqual(["a 2026-10-09T17:02:19Z start", "err", "exit"]);
    expect(lastCycle(["one", "two", "two"])).toEqual(["one", "two", "two"]);
    expect(lastCycle(["one", "two"])).toEqual(["one", "two"]);
  });
});

describe("deploy success email", () => {
  const success = fixture<"deploy.success">("deploy-success");

  it("mentions the first deploy, and the recap date only once one is scheduled", () => {
    expect(firstDeployNote(success, FIXTURE_CONTEXT)).toBeUndefined();
    expect(firstDeployNote({ ...success, firstDeploy: true }, FIXTURE_CONTEXT)).toBe("First deploy of acme-web.");
    expect(firstDeployNote({ ...success, firstDeploy: true, recapAt: "2026-10-12T03:00:00.000Z" }, { ...FIXTURE_CONTEXT, timeZone: "America/Los_Angeles" })).toBe(
      "First deploy of acme-web. Its 72-hour recap arrives Oct 11.",
    );
  });

  it("leaves out the rollback line on a first deploy", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-success-first"), FIXTURE_CONTEXT))!;
    expect(email.text).toContain("First deploy of acme-web. Its 72-hour recap arrives Oct 12.");
    expect(email.text).not.toContain("Rollback:");
  });
});

describe("deploy incomplete email", () => {
  it("says the old version didn't stop and quotes Docker", async () => {
    const email = (await renderNotificationEmail(fixture("deploy-incomplete"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ⚠ Formbricks is live · the old version is still running");
    expect(email.text).toContain("Docker reported: tried to kill container, but did not receive an exit event.");
    expect(daemonReason("Error response from daemon: cannot stop container: x-1: tried to kill container.")).toBe("tried to kill container");
  });

  it("calls other unfinished work cleanup", () => {
    expect(subjectLine(fixture("deploy-incomplete-shared"))).toBe("⚠ Shop is live · cleanup didn't finish");
  });
});

describe("rollback email", () => {
  it("names the commit serving and the one that stopped", async () => {
    const email = (await renderNotificationEmail(fixture("auto-rollback"), FIXTURE_CONTEXT))!;
    expect(email.subject).toBe("node-a · ↩ acme-web rolled back to the previous version");
    expect(email.text).toContain("The site is up. The previous version, e4f5a6b, is serving again.");
    expect(email.text).toContain("The new version stopped 40 seconds after going live");
    expect(email.text).toContain("a1b2c3d Fix donation form validation on mobile passed its health check");
    expect(email.html).toContain('href="https://github.com/acme/acme-web/commit/e4f5a6b7c8d90123456789abcdef0123456789ab"');
  });

  it("still reads without the commits", async () => {
    const bare = { ...fixture<"deploy.rollback">("auto-rollback"), servingSha: undefined, gitSha: undefined, liveMs: undefined };
    const email = (await renderNotificationEmail(bare, FIXTURE_CONTEXT))!;
    expect(email.text).toContain("The site is up. The previous version is serving again.");
    expect(email.text).toContain("The new version stopped soon after going live\nIt passed its health check");
  });
});

describe("deploy email copy", () => {
  it.each(EMAIL_FIXTURES.filter((f) => DEPLOY_TYPES.has(f.event.type)).map((f) => [f.name, f.event] as const))(
    "%s never says slot, blue/green, release or health wait",
    async (_name, event) => {
      const email = (await renderNotificationEmail(event, FIXTURE_CONTEXT))!;
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/\bslots?\b|blue\/green|\brelease\b|health wait/i);
      }
      expect(notificationSubject(event, FIXTURE_CONTEXT)).toMatch(/^node-a · [✓✗⚠↩] /);
    },
  );
});
