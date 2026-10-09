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

const FLAG = "--disable_metrics=advtcp,app,cpuLoad,cpu_topology,cpuset,hugetlb,memory_numa,oom_event,percpu,pressure,process,referenced_memory,resctrl,sched,tcp,udp";

describe("applyCadvisorDiskMetrics", () => {
  it("ships disk metrics off: `disk` disabled, 256m", async () => {
    const content = await cadvisorComposeContent();
    expect(applyCadvisorDiskMetrics(content, false)).toBe(content);
    expect(content).toContain(`${FLAG},disk\n`);
    expect(content).toContain("mem_limit: 256m");
  });

  it("keeps cpu, memory, network and diskIO collectors on", async () => {
    const content = await cadvisorComposeContent();
    const flag = content.match(/--disable_metrics=(\S+)/)![1].split(",");
    for (const needed of ["cpu", "memory", "network", "diskIO"]) expect(flag).not.toContain(needed);
  });

  it("enables disk and raises the memory limit to 512m when on", async () => {
    const content = await cadvisorComposeContent();
    const result = applyCadvisorDiskMetrics(content, true);

    expect(result).toContain(`${FLAG}\n`);
    expect(result).not.toContain(",disk");
    expect(result).toContain("mem_limit: 512m");
    expect(result).not.toContain("mem_limit: 256m");
  });

  it("falls back to the input unchanged when the expected markers are missing", () => {
    const drifted = "services:\n  cadvisor:\n    image: gcr.io/cadvisor/cadvisor:latest\n";
    expect(applyCadvisorDiskMetrics(drifted, true)).toBe(drifted);
  });
});
