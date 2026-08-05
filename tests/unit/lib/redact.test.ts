import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { redactSecrets, redactValues, redactError, REDACTED } from "@/lib/redact";
import { execFileAsync } from "@/lib/utils/exec";

// ---------------------------------------------------------------------------
// Redaction of credentials on their way out of the process.
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = "ghs_16CharsAndThenSomeMoreABCDEF123456";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("redactSecrets", () => {
  it("removes the password from a URL", () => {
    const out = redactSecrets(`git clone https://x-access-token:${GITHUB_TOKEN}@github.com/acme/app`);

    expect(out).not.toContain(GITHUB_TOKEN);
    expect(out).toContain("github.com/acme/app");
  });

  it("removes a bare token used as URL userinfo", () => {
    expect(redactSecrets(`https://${GITHUB_TOKEN}@github.com/acme/app`)).not.toContain(GITHUB_TOKEN);
  });

  it("removes provider token shapes anywhere in the text", () => {
    expect(redactSecrets(`token is ${GITHUB_TOKEN}`)).not.toContain(GITHUB_TOKEN);
    expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("removes a private key body, not just its header", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";

    const out = redactSecrets(`failed to read key: ${pem}`);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
    expect(out).toContain(REDACTED);
  });

  it("removes secret-named environment assignments", () => {
    const out = redactSecrets("env PGPASSWORD=hunter2000 AWS_SECRET_ACCESS_KEY=abcdef123456");

    expect(out).not.toContain("hunter2000");
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("PGPASSWORD=");
  });

  it("removes credential-carrying CLI flags in both forms", () => {
    expect(redactSecrets("restic --password=hunter2000")).not.toContain("hunter2000");
    expect(redactSecrets("mc --secret-key hunter2000 alias")).not.toContain("hunter2000");
  });

  it("removes Authorization header values", () => {
    expect(redactSecrets("Authorization: Bearer abcdef123456789")).not.toContain("abcdef123456789");
  });

  it("removes the base64 auth blob from a docker config", () => {
    const out = redactSecrets('{"auths":{"ghcr.io":{"auth":"dXNlcjpwYXNzd29yZA=="}}}');

    expect(out).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(out).toContain("ghcr.io");
  });

  it("leaves ordinary log lines alone", () => {
    const line = "[deploy] Pulled latest from main";
    expect(redactSecrets(line)).toBe(line);
  });

  it("keeps neither the length nor a prefix of what it removed", () => {
    const out = redactSecrets(`https://user:${AWS_SECRET}@s3.example.com/bucket`);

    expect(out).not.toContain(AWS_SECRET);
    expect(out).not.toContain(AWS_SECRET.slice(0, 4));
    expect(out).not.toMatch(new RegExp(`.{${AWS_SECRET.length}}@s3`));
    expect(out).toContain(REDACTED);
  });
});

describe("redactValues", () => {
  it("removes a known value whatever shape it has", () => {
    expect(redactValues("prefix-s3cr3tvalue-suffix", ["s3cr3tvalue"])).toBe(`prefix-${REDACTED}-suffix`);
  });

  it("ignores values too short to be worth matching", () => {
    expect(redactValues("a b c", ["a"])).toBe("a b c");
  });
});

describe("redactError", () => {
  it("cleans message, cmd, stderr and stack together", () => {
    const err = Object.assign(new Error(`Command failed: git clone https://x:${GITHUB_TOKEN}@github.com/a/b`), {
      cmd: `git clone https://x:${GITHUB_TOKEN}@github.com/a/b`,
      stderr: `fatal: could not read from https://x:${GITHUB_TOKEN}@github.com/a/b`,
      stdout: "",
    });

    redactError(err);

    expect(err.message).not.toContain(GITHUB_TOKEN);
    expect(err.cmd).not.toContain(GITHUB_TOKEN);
    expect(err.stderr).not.toContain(GITHUB_TOKEN);
    expect(err.stack).not.toContain(GITHUB_TOKEN);
  });

  it("passes non-errors through", () => {
    expect(redactError("plain")).toBe("plain");
    expect(redactError(null)).toBe(null);
  });
});

describe("execFileAsync", () => {
  it("does not let a credential on argv survive into the error", async () => {
    const url = `https://x-access-token:${GITHUB_TOKEN}@github.com/acme/app`;

    const err = await execFileAsync("/bin/sh", ["-c", "exit 3", url]).then(
      () => null,
      (e: Error & { cmd?: string }) => e,
    );

    expect(err).toBeTruthy();
    expect(err!.message).toContain("Command failed");
    expect(err!.message).not.toContain(GITHUB_TOKEN);
    expect(err!.cmd).not.toContain(GITHUB_TOKEN);
    expect(err!.stack).not.toContain(GITHUB_TOKEN);
  });

  it("keeps a credential echoed on stderr out of the error", async () => {
    const err = await execFileAsync("/bin/sh", [
      "-c",
      `echo "fatal: repository 'https://x-access-token:${GITHUB_TOKEN}@github.com/a/b' not found" >&2; exit 128`,
    ]).then(
      () => null,
      (e: Error & { stderr?: string }) => e,
    );

    expect(err!.stderr).not.toContain(GITHUB_TOKEN);
    expect(err!.message).not.toContain(GITHUB_TOKEN);
  });

  it("returns output unchanged when the command succeeds", async () => {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", "echo ok"]);
    expect(stdout.trim()).toBe("ok");
  });
});

describe("exec call sites", () => {
  it("all go through the redacting wrapper", async () => {
    const { readdirSync, readFileSync } = await import("fs");
    const { join } = await import("path");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(path);
        } else if (entry.name.endsWith(".ts") && path !== join("lib", "utils", "exec.ts")) {
          if (/promisify\(\s*execFile\s*\)/.test(readFileSync(path, "utf-8"))) offenders.push(path);
        }
      }
    };
    walk("lib");
    walk("app");

    expect(offenders).toEqual([]);
  });

  it("proves the raw promisified execFile is what leaks", async () => {
    const url = `https://x-access-token:${GITHUB_TOKEN}@github.com/acme/app`;

    const err = await new Promise<Error & { cmd?: string }>((resolve) => {
      execFile("/bin/sh", ["-c", "exit 3", url], (e) => resolve(e as Error & { cmd?: string }));
    });

    expect(err.message).toContain(GITHUB_TOKEN);
  });
});
