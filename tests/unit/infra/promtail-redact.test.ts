import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

type Stage = { replace?: { expression: string; replace: string } };

const template = YAML.parse(readFileSync(resolve(process.cwd(), "templates/promtail.yaml"), "utf-8")) as { composeContent: string };
const compose = YAML.parse(template.composeContent) as { configs: Record<string, { content: string }> };
const config = YAML.parse(compose.configs["promtail-config"].content) as { scrape_configs: { pipeline_stages: Stage[] }[] };
const stage = config.scrape_configs[0].pipeline_stages.find((s) => s.replace)!.replace!;

// Promtail's replace stage swaps each capture group for the replacement. RE2's leading (?i) becomes the i flag.
function redact(line: string): string {
  expect(stage.expression.startsWith("(?i)")).toBe(true);
  const re = new RegExp(stage.expression.slice(4), "gi");
  return line.replace(re, (match: string, value: string) => match.slice(0, match.length - value.length) + stage.replace);
}

// Traefik's JSON access log writes & as &.
const amp = "\\u0026";

describe("promtail credential redaction", () => {
  it("masks credential values in Traefik's RequestPath", () => {
    const line = `{"RequestHost":"sonarr.example.com","RequestPath":"/api/v3/queue?page=1${amp}apikey=SECRET1${amp}Token=SECRET2","RequestMethod":"GET"}`;
    expect(redact(line)).toBe(`{"RequestHost":"sonarr.example.com","RequestPath":"/api/v3/queue?page=1${amp}apikey=REDACTED${amp}Token=REDACTED","RequestMethod":"GET"}`);
  });

  it("covers each parameter, in any case", () => {
    for (const key of ["api_key", "APIKEY", "token", "Access_Token", "password"]) {
      expect(redact(`{"RequestPath":"/x?${key}=s3cr%40t"}`)).toBe(`{"RequestPath":"/x?${key}=REDACTED"}`);
    }
  });

  it("stops at the next parameter, a fragment or a plain &", () => {
    const value = "fixture-value";
    expect(redact(`{"RequestPath":"/login?password=${value}#top"}`)).toBe(`{"RequestPath":"/login?password=REDACTED#top"}`);
    expect(redact(`"GET /rss?ApiKey=SECRET&q=x HTTP/1.1" 200`)).toBe(`"GET /rss?ApiKey=REDACTED&q=x HTTP/1.1" 200`);
  });

  it("leaves other parameters and lookalike names alone", () => {
    const line = `{"RequestPath":"/x?page=2${amp}sort=token${amp}tokenish=keep${amp}mytoken=keep2${amp}token_type=bearer"}`;
    expect(redact(line)).toBe(line);
  });
});
