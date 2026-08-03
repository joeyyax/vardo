import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

import { LOOKBACK_MS } from "@/lib/logging/history";
import { parseCompose } from "@/lib/docker/compose-parse";

// Retention deletes data and the positions file decides what gets re-shipped.
// Both ship inside template compose, so both are read back the way the
// container gets them.

type Compose = ReturnType<typeof parseCompose>;

function template(name: string): Compose {
  const path = resolve(process.cwd(), `templates/${name}.yaml`);
  const raw = YAML.parse(readFileSync(path, "utf-8")) as { composeContent: string };
  return parseCompose(raw.composeContent);
}

function serviceConfig(compose: Compose, key: string): string {
  const entry = compose.configs?.[key] as { content: string };
  expect(entry?.content).toBeTypeOf("string");
  return entry.content;
}

/** Loki durations are written as hours. */
function hours(value: string): number {
  const match = /^(\d+)h$/.exec(value);
  expect(match, `expected an hour duration, got "${value}"`).not.toBeNull();
  return Number(match![1]);
}

describe("Loki retention", () => {
  const compose = template("loki");
  const config = YAML.parse(serviceConfig(compose, "loki-config")) as {
    limits_config: {
      retention_period: string;
      reject_old_samples: boolean;
      reject_old_samples_max_age: string;
    };
    compactor: { retention_enabled: boolean; delete_request_store: string };
  };

  it("keeps logs at least as long as the viewer's widest lookback", () => {
    const widestMs = Math.max(...LOOKBACK_MS);
    expect(hours(config.limits_config.retention_period) * 3_600_000).toBeGreaterThanOrEqual(
      widestMs,
    );
  });

  it("runs a compactor, without which retention_period deletes nothing", () => {
    expect(config.compactor.retention_enabled).toBe(true);
    expect(config.compactor.delete_request_store).toBe("filesystem");
  });

  it("never refuses a sample it would have kept", () => {
    expect(config.limits_config.reject_old_samples).toBe(true);
    expect(hours(config.limits_config.reject_old_samples_max_age)).toBe(
      hours(config.limits_config.retention_period),
    );
  });
});

describe("Promtail positions", () => {
  const compose = template("promtail");
  const config = YAML.parse(serviceConfig(compose, "promtail-config")) as {
    positions: { filename: string };
  };

  it("writes positions onto a volume, so a redeploy does not replay every log", () => {
    const dir = config.positions.filename.replace(/\/[^/]+$/, "");
    const mounts = compose.services.promtail.volumes as string[];
    const mount = mounts.find((v) => v.endsWith(`:${dir}`));
    expect(mount, `no volume mounted at ${dir}`).toBeDefined();

    const volume = mount!.split(":")[0];
    expect(volume).not.toContain("/");
    expect(compose.volumes).toHaveProperty(volume);
  });
});

describe("Promtail container labels", () => {
  const compose = template("promtail");
  const scrape = (
    YAML.parse(serviceConfig(compose, "promtail-config")) as {
      scrape_configs: {
        relabel_configs: {
          source_labels?: string[];
          target_label?: string;
          regex?: string;
          replacement?: string;
          action?: string;
        }[];
      }[];
    }
  ).scrape_configs[0];

  // The docker target ships an entry whether or not relabelling kept it, and a
  // dropped target loses every label — so a keep here silently produces
  // {service_name="unknown_service"} rather than dropping anything.
  it("uses no keep or drop action, which the docker target ignores", () => {
    const actions = scrape.relabel_configs.map((r) => r.action).filter(Boolean);
    expect(actions).not.toContain("keep");
    expect(actions).not.toContain("drop");
  });

  it("labels an unmanaged container as instance-level rather than leaving it bare", () => {
    expect(scrape.relabel_configs).toContainEqual({
      target_label: "scope",
      replacement: "instance",
    });
  });

  it("marks a Vardo-managed container as an app", () => {
    expect(scrape.relabel_configs).toContainEqual({
      source_labels: ["__tmp_managed"],
      regex: "true",
      target_label: "scope",
      replacement: "app",
    });
  });
});

describe("the standalone logging configs", () => {
  // Two plausible configs where one is a decoy is how the wrong file gets edited.
  it("are gone, leaving the templates as the only source", () => {
    expect(existsSync(resolve(process.cwd(), "config/loki.yml"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "config/promtail.yml"))).toBe(false);
  });
});
