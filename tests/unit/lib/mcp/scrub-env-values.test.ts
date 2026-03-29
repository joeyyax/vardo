import { describe, it, expect } from "vitest";
import { scrubEnvValues } from "@/lib/mcp/tools/get-deploy-logs";

// ---------------------------------------------------------------------------
// scrubEnvValues — security-sensitive redaction of env var values in build logs
// ---------------------------------------------------------------------------
// Nixpacks and Railpack may echo variable assignments in their build output.
// This verifies the redaction is both correct (catches real patterns) and
// conservative (doesn't corrupt unrelated log content).

describe("scrubEnvValues", () => {
  it("redacts a simple KEY=value assignment", () => {
    expect(scrubEnvValues("DATABASE_URL=postgres://localhost/db")).toBe(
      "DATABASE_URL=[redacted]"
    );
  });

  it("redacts mid-line env assignments", () => {
    const log = "Setting DATABASE_URL=postgres://user:pass@host/db in environment";
    expect(scrubEnvValues(log)).toBe(
      "Setting DATABASE_URL=[redacted] in environment"
    );
  });

  it("redacts multiple assignments in one line", () => {
    const log = "SECRET_KEY=abc123 API_TOKEN=xyz789";
    expect(scrubEnvValues(log)).toBe(
      "SECRET_KEY=[redacted] API_TOKEN=[redacted]"
    );
  });

  it("redacts assignments across multiple lines", () => {
    const log = "DATABASE_URL=postgres://localhost\nSECRET_KEY=hunter2\nOK";
    expect(scrubEnvValues(log)).toBe(
      "DATABASE_URL=[redacted]\nSECRET_KEY=[redacted]\nOK"
    );
  });

  it("redacts uppercase names with digits and underscores", () => {
    expect(scrubEnvValues("AWS_S3_BUCKET_NAME_V2=my-bucket")).toBe(
      "AWS_S3_BUCKET_NAME_V2=[redacted]"
    );
  });

  it("does not redact short two-character names", () => {
    // The pattern requires 3+ characters: [A-Z_][A-Z0-9_]{2,}
    const log = "AB=value";
    expect(scrubEnvValues(log)).toBe("AB=value");
  });

  it("does not redact lowercase variable names", () => {
    const log = "path=/usr/local/bin";
    expect(scrubEnvValues(log)).toBe("path=/usr/local/bin");
  });

  it("does not alter log lines with no env assignments", () => {
    const log = "Step 1/5 : FROM node:18-alpine\nSuccessfully built abc123";
    expect(scrubEnvValues(log)).toBe(log);
  });

  it("handles an empty string", () => {
    expect(scrubEnvValues("")).toBe("");
  });

  it("preserves surrounding text while redacting the value only", () => {
    const log = "[build] DATABASE_URL=secret done";
    expect(scrubEnvValues(log)).toBe("[build] DATABASE_URL=[redacted] done");
  });

  it("does not redact values that are already quoted (double quotes stop at quote boundary)", () => {
    // The pattern excludes " from value chars — quoted values stop at the quote
    const log = 'KEY="quoted value"';
    // The regex [^\s"'\n]+ stops before the quote, so KEY= has no value to redact
    // (the char after = is " which is excluded), leaving it unchanged
    expect(scrubEnvValues(log)).toBe('KEY="quoted value"');
  });
});
