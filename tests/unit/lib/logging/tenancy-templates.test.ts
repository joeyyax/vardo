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
      relabel_configs: {
        source_labels?: string[];
        target_label?: string;
        regex?: string;
        replacement?: string;
      }[];
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

  // Promtail's and Loki's errors quote the stream labels and tenant ids they
  // refused, which name other organizations. Vardo's own containers carry
  // vardo.scope=instance, so the rule keys off that rather than naming them.
  describe("instance infrastructure", () => {
    const SCOPE_LABEL = "__meta_docker_container_label_vardo_scope";
    const rules = scrape.relabel_configs.filter((r) => r.source_labels?.[0] === SCOPE_LABEL);

    it("drops the organization, so the tenant falls back to the client default", () => {
      expect(rules).toContainEqual({
        source_labels: [SCOPE_LABEL],
        regex: "instance",
        target_label: "organization",
        replacement: "",
      });
    });

    it("is labelled instance-level alongside the unmanaged containers", () => {
      expect(rules).toContainEqual({
        source_labels: [SCOPE_LABEL],
        regex: "instance",
        target_label: "scope",
        replacement: "instance",
      });
    });

    it("names no individual service, so a new core service needs no config change", () => {
      const config = JSON.stringify(scrape.relabel_configs);
      for (const service of ["promtail", "loki", "cadvisor", "vardo"]) {
        expect(config).not.toContain(`"${service}"`);
      }
    });

    // Relabelling runs in order, so the organization has to be set before
    // these clear it.
    it("runs after the organization it clears", () => {
      const sets = scrape.relabel_configs.findLastIndex(
        (r) => r.target_label === "organization" && r.source_labels?.[0] !== SCOPE_LABEL,
      );
      const clears = scrape.relabel_configs.findIndex(
        (r) => r.source_labels?.[0] === SCOPE_LABEL && r.target_label === "organization",
      );

      expect(sets).toBeGreaterThanOrEqual(0);
      expect(clears).toBeGreaterThan(sets);
    });
  });
});
