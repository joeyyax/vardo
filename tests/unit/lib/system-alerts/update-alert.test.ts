import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkUpdateAlert } from "@/lib/system-alerts/monitor";

const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));

vi.mock("@/lib/utils/exec", () => ({ execFileAsync }));
vi.mock("@/lib/config/health", () => ({ getSystemHealth: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ domainCertChecks: {}, systemSettings: {} }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: vi.fn() }));
vi.mock("@/lib/system-alerts/cert-probe", () => ({ probeCertificate: vi.fn() }));
vi.mock("@/lib/system-alerts/state", () => ({
  shouldFire: vi.fn(() => false),
  markFired: vi.fn(),
  clearFired: vi.fn(),
  loadAlertState: vi.fn(),
}));


const gitCalls = () => execFileAsync.mock.calls.map((c) => (c[1] as string[]).join(" "));

describe("checkUpdateAlert", () => {
  beforeEach(() => {
    execFileAsync.mockReset();
  });

  it("skips ls-remote outside a git checkout", async () => {
    execFileAsync.mockImplementation(async () => {
      throw new Error("fatal: not a git repository");
    });

    await checkUpdateAlert();

    expect(gitCalls()).toEqual(["rev-parse HEAD"]);
  });

  it("runs ls-remote once rev-parse succeeds", async () => {
    execFileAsync.mockResolvedValue({ stdout: "abc\tHEAD\n", stderr: "" });

    await checkUpdateAlert();

    expect(gitCalls()).toEqual(["rev-parse HEAD", "ls-remote origin HEAD"]);
  });
});
