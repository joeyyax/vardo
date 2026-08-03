import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

import { UNASSIGNED_TENANT } from "@/lib/logging/client";
import { parseCompose } from "@/lib/docker/compose-parse";

// Tenant separation is only as good as the config that ships. Both halves live
// in template compose, one behind a `configs:` entry, so both are read back the
// way the container gets them.

function serviceConfig(template: string, service: string, key: string): string {
  const path = resolve(process.cwd(), `templates/${template}.yaml`);
  const raw = YAML.parse(readFileSync(path, "utf-8")) as { composeContent: string };
  const compose = parseCompose(raw.composeContent);

  const mount = compose.services[service].configs?.[0];
  expect(mount).toMatchObject({ source: key });

  const entry = compose.configs?.[key] as { content: string };
  expect(entry?.content).toBeTypeOf("string");
  return entry.content;
}

describe("the Loki template", () => {
  const raw = serviceConfig("loki", "loki", "loki-config");

  it("runs with auth on, so a request without a tenant is rejected", () => {
    expect((YAML.parse(raw) as { auth_enabled: boolean }).auth_enabled).toBe(true);
  });

  it("keeps the schema the running instance already indexed against", () => {
    expect(raw).toContain("from: 2020-10-24");
    expect(raw).toContain("schema: v13");
  });
});

describe("the Promtail template", () => {
  const config = YAML.parse(serviceConfig("promtail", "promtail", "promtail-config")) as {
    clients: { tenant_id: string }[];
    scrape_configs: {
      relabel_configs: { source_labels?: string[]; target_label?: string; regex?: string }[];
      pipeline_stages: { tenant?: { label: string } }[];
    }[];
  };
  const scrape = config.scrape_configs[0];

  it("takes the tenant from the container's owning organization", () => {
    expect(scrape.pipeline_stages).toContainEqual({ tenant: { label: "organization" } });
  });

  it("fills that label from the organization Vardo stamps on the container", () => {
    expect(scrape.relabel_configs).toContainEqual({
      source_labels: ["__meta_docker_container_label_vardo_organization"],
      regex: "(.+)",
      target_label: "organization",
    });
  });

  it("parks a container with no organization where no organization can read it", () => {
    expect(config.clients[0].tenant_id).toBe(UNASSIGNED_TENANT);
    expect(UNASSIGNED_TENANT).toContain(".");
  });
});
