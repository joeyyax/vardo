import { describe, it, expect } from "vitest";
import type { CronFailedEvent } from "@/lib/bus/events";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { cronCause, cronFailedMail, firstErrorLine } from "@/lib/email/templates/cron-failed";

const base = EMAIL_FIXTURES.find((f) => f.name === "cron-failed-exit")!.event as CronFailedEvent;
const event = (over: Partial<CronFailedEvent>): CronFailedEvent => ({ ...base, ...over });

describe("cronCause", () => {
  it("reads PHP's memory limit and the file it died in", () => {
    const line = "PHP Fatal error:  Allowed memory size of 268435456 bytes exhausted (tried to allocate 4096 bytes) in /app/src/Importer.php on line 9";
    expect(cronCause(event({ command: "php artisan import" }), [line])).toEqual({
      title: "PHP ran out of memory",
      body: "It hit PHP's 256 MB limit in Importer. Raise memory_limit or trim what the job loads.",
    });
  });

  it("names an exit code only when its meaning is fixed", () => {
    expect(cronCause(event({ exitCode: 137 }), ["done"])?.title).toBe("The process was killed");
    expect(cronCause(event({ exitCode: 127 }), ["sh: foo: not found"])?.title).toBe("Command not found");
    expect(cronCause(event({ exitCode: 1 }), ["boom"])).toBeNull();
  });

  it("explains a URL job's HTTP status", () => {
    expect(cronCause(event({ jobType: "url", exitCode: 502 }), [])?.title).toBe("The URL returned 502");
    expect(cronCause(event({ jobType: "url", exitCode: 418 }), [])).toBeNull();
  });
});

describe("cronFailedMail", () => {
  it("titles the callout with the first error line when the cause is unknown", () => {
    const lines = ["starting", "Error: connect ECONNREFUSED 10.0.0.5:5432", "Error: retry failed"];
    expect(firstErrorLine(lines)).toBe(1);
    const body = cronFailedMail(event({ exitCode: 1, logTail: lines }), FIXTURE_CONTEXT);
    const callout = body.blocks?.find((b) => b.kind === "callout");
    expect(callout).toMatchObject({ title: "Error: connect ECONNREFUSED 10.0.0.5:5432", body: "Exit code 1." });
    expect(body.blocks?.find((b) => b.kind === "log")).toMatchObject({ highlight: [1] });
  });

  it("draws recent runs only from history the event carries", () => {
    const strip = (runs?: CronFailedEvent["recentRuns"]) => cronFailedMail(event({ recentRuns: runs }), FIXTURE_CONTEXT).blocks?.find((b) => b.kind === "days");
    expect(strip(undefined)).toBeUndefined();
    expect(strip(["failed"])).toBeUndefined();
    expect(strip(["success", "failed", "failed"])).toMatchObject({ days: ["ok", "fail", "fail"] });
  });

  it("links a URL job's URL in place of the command", () => {
    const body = cronFailedMail(event({ jobType: "url", target: "https://example.com/cron", command: undefined }), FIXTURE_CONTEXT);
    expect(body.facts?.find((f) => f.label === "URL")?.href).toBe("https://example.com/cron");
    expect(body.facts?.some((f) => f.label === "Command")).toBe(false);
  });
});
