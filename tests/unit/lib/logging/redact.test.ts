import { describe, expect, it } from "vitest";

import { redactLine } from "@/lib/logging/redact";

// Traefik's JSON access log writes & as &.
const amp = "\\u0026";

describe("redactLine", () => {
  it("masks credential values in Traefik's RequestPath", () => {
    const line = `{"RequestHost":"sonarr.example.com","RequestPath":"/api/v3/queue?page=1${amp}apikey=SECRET1${amp}Token=SECRET2","RequestMethod":"GET"}`;
    expect(redactLine(line)).toBe(`{"RequestHost":"sonarr.example.com","RequestPath":"/api/v3/queue?page=1${amp}apikey=REDACTED${amp}Token=REDACTED","RequestMethod":"GET"}`);
  });

  it("covers each parameter, in any case", () => {
    for (const key of ["api_key", "APIKEY", "token", "Access_Token", "password"]) {
      expect(redactLine(`{"RequestPath":"/x?${key}=s3cr%40t"}`)).toBe(`{"RequestPath":"/x?${key}=REDACTED"}`);
    }
  });

  it("stops at the next parameter, a fragment or a plain &", () => {
    expect(redactLine(`{"RequestPath":"/login?password=fixture-value#top"}`)).toBe(`{"RequestPath":"/login?password=REDACTED#top"}`);
    expect(redactLine(`"GET /rss?ApiKey=SECRET&q=x HTTP/1.1" 200`)).toBe(`"GET /rss?ApiKey=REDACTED&q=x HTTP/1.1" 200`);
  });

  it("leaves other parameters and lookalike names alone", () => {
    const line = `{"RequestPath":"/x?page=2${amp}sort=token${amp}tokenish=keep${amp}mytoken=keep2${amp}token_type=bearer"}`;
    expect(redactLine(line)).toBe(line);
  });
});
