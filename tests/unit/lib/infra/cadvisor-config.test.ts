import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { applyCadvisorDiskMetrics } from "@/lib/infra/cadvisor-config";
import { loadTemplates } from "@/lib/templates/load";

// Loaded through the real template pipeline (YAML.parse dedents the block
// scalar) so this exercises the exact string provision.ts works with, not a
// hand-copied fixture that could drift from what YAML.parse actually produces.
async function cadvisorComposeContent(): Promise<string> {
  const templates = await loadTemplates();
  const template = templates.find((t) => t.name === "cadvisor");
  if (!template?.composeContent) throw new Error("cadvisor template not found");
  return template.composeContent;
}

describe("applyCadvisorDiskMetrics", () => {
  it("leaves the template untouched when disk metrics are on", async () => {
    const content = await cadvisorComposeContent();
    expect(applyCadvisorDiskMetrics(content, true)).toBe(content);
  });

  it("disables disk and diskIO and drops the memory limit to 256m when off", async () => {
    const content = await cadvisorComposeContent();
    const result = applyCadvisorDiskMetrics(content, false);

    expect(result).toContain("--disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp,disk,diskIO");
    expect(result).toContain("mem_limit: 256m");
    expect(result).not.toContain("mem_limit: 512m");
    expect(result).not.toContain("--disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp\n");
  });

  it("falls back to the input unchanged when the expected markers are missing", () => {
    const drifted = "services:\n  cadvisor:\n    image: gcr.io/cadvisor/cadvisor:latest\n";
    expect(applyCadvisorDiskMetrics(drifted, false)).toBe(drifted);
  });
});
