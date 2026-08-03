import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// POST/GET /api/v1/admin/core-services/cadvisor-disk-metrics
// ---------------------------------------------------------------------------
// Auth, DB, templates, and deploy are mocked. applyCadvisorDiskMetrics is the
// real implementation so these tests also cover both toggle states end to end.
// CADVISOR_COMPOSE is loaded through the real (unmocked) template pipeline so
// it matches exactly what YAML.parse hands the route in production.

let CADVISOR_COMPOSE: string;

const { mockFindFirst, mockUpdateSet, mockGetCadvisorConfig, mockSetCadvisorConfig, mockRequestDeploy, mockLoadTemplates } =
  vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockUpdateSet: vi.fn(),
    mockGetCadvisorConfig: vi.fn(),
    mockSetCadvisorConfig: vi.fn().mockResolvedValue(undefined),
    mockRequestDeploy: vi.fn(),
    mockLoadTemplates: vi.fn(),
  }));

vi.mock("@/lib/auth/admin", () => ({
  requireAppAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1" } }),
}));

vi.mock("@/lib/api/with-rate-limit", () => ({
  withRateLimit: (handler: (...args: unknown[]) => unknown) => handler,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: { apps: { findFirst: mockFindFirst } },
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        mockUpdateSet(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  apps: { name: "name", parentAppId: "parentAppId", id: "id" },
}));

vi.mock("@/lib/infra/cadvisor-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/cadvisor-config")>()),
  getCadvisorConfig: mockGetCadvisorConfig,
  setCadvisorConfig: mockSetCadvisorConfig,
}));

vi.mock("@/lib/templates/load", () => ({ loadTemplates: mockLoadTemplates }));
vi.mock("@/lib/docker/deploy-cancel", () => ({ requestDeploy: mockRequestDeploy }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { GET, POST } from "@/app/api/v1/admin/core-services/cadvisor-disk-metrics/route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/v1/admin/core-services/cadvisor-disk-metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const real = await vi.importActual<typeof import("@/lib/templates/load")>("@/lib/templates/load");
  const templates = await real.loadTemplates();
  const cadvisor = templates.find((t) => t.name === "cadvisor");
  if (!cadvisor?.composeContent) throw new Error("cadvisor template not found");
  CADVISOR_COMPOSE = cadvisor.composeContent;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSetCadvisorConfig.mockResolvedValue(undefined);
  mockLoadTemplates.mockResolvedValue([
    { name: "cadvisor", displayName: "cAdvisor", composeContent: CADVISOR_COMPOSE },
  ]);
});

describe("GET /api/v1/admin/core-services/cadvisor-disk-metrics", () => {
  it("returns the stored config", async () => {
    mockGetCadvisorConfig.mockResolvedValue({ diskMetricsEnabled: false });

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({ diskMetricsEnabled: false });
  });
});

describe("POST /api/v1/admin/core-services/cadvisor-disk-metrics", () => {
  it("rejects a non-boolean body", async () => {
    const res = await POST(postRequest({ diskMetricsEnabled: "off" }), {});
    expect(res.status).toBe(400);
  });

  it("saves the setting without redeploying when cAdvisor isn't installed", async () => {
    mockFindFirst.mockResolvedValue(null);

    const res = await POST(postRequest({ diskMetricsEnabled: false }), {});
    const body = await res.json();

    expect(mockSetCadvisorConfig).toHaveBeenCalledWith({ diskMetricsEnabled: false });
    expect(body).toEqual({ diskMetricsEnabled: false, installed: false, redeployed: false });
    expect(mockRequestDeploy).not.toHaveBeenCalled();
  });

  it("turns disk metrics off: rewrites compose, drops the memory limit, and redeploys", async () => {
    mockFindFirst.mockResolvedValue({ id: "app-1", organizationId: "org-1", isSystemManaged: true });
    mockRequestDeploy.mockResolvedValue({ success: true });

    const res = await POST(postRequest({ diskMetricsEnabled: false }), {});
    const body = await res.json();

    const composeContent = mockUpdateSet.mock.calls[0][0].composeContent as string;
    expect(composeContent).toContain("--disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp,disk,diskIO");
    expect(composeContent).toContain("mem_limit: 256m");
    expect(mockUpdateSet.mock.calls[0][0].needsRedeploy).toBe(true);
    expect(mockRequestDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app-1", organizationId: "org-1" }),
    );
    expect(body).toEqual({ diskMetricsEnabled: false, installed: true, redeployed: true });
  });

  it("turns disk metrics on: restores the default compose and redeploys", async () => {
    mockFindFirst.mockResolvedValue({ id: "app-1", organizationId: "org-1", isSystemManaged: true });
    mockRequestDeploy.mockResolvedValue({ success: true });

    const res = await POST(postRequest({ diskMetricsEnabled: true }), {});
    const body = await res.json();

    const composeContent = mockUpdateSet.mock.calls[0][0].composeContent as string;
    expect(composeContent).toBe(CADVISOR_COMPOSE);
    expect(body).toEqual({ diskMetricsEnabled: true, installed: true, redeployed: true });
  });

  it("reports redeployed: false when the redeploy fails, without throwing", async () => {
    mockFindFirst.mockResolvedValue({ id: "app-1", organizationId: "org-1", isSystemManaged: true });
    mockRequestDeploy.mockResolvedValue({ success: false });

    const res = await POST(postRequest({ diskMetricsEnabled: false }), {});
    const body = await res.json();

    expect(body).toEqual({ diskMetricsEnabled: false, installed: true, redeployed: false });
  });
});
