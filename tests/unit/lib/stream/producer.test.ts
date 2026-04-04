import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { redisMock, settingsMock } = vi.hoisted(() => {
  const redisMock = {
    xadd: vi.fn().mockResolvedValue("1234567890-0"),
  };

  const settingsMock = {
    getSystemSettingRaw: vi.fn().mockResolvedValue(null),
  };

  return { redisMock, settingsMock };
});

vi.mock("@/lib/redis", () => ({ redis: redisMock }));

vi.mock("@/lib/system-settings", () => ({
  getSystemSettingRaw: settingsMock.getSystemSettingRaw,
}));

// Reset config cache between tests so getStreamMaxLen re-reads
import { resetStreamConfig } from "@/lib/stream/config";
import { addEvent, addDeployLog, addToast, addInstallEvent } from "@/lib/stream/producer";
import { eventStream, deployStream, toastStream, installStream } from "@/lib/stream/keys";
import { getStreamMaxLen } from "@/lib/stream/config";

// ---------------------------------------------------------------------------
// Stream key generation
// ---------------------------------------------------------------------------

describe("stream keys", () => {
  it("generates org-scoped event stream key", () => {
    expect(eventStream("org-123")).toBe("stream:events:org-123");
  });

  it("generates deploy-specific stream key", () => {
    expect(deployStream("deploy-abc")).toBe("stream:deploy:deploy-abc");
  });

  it("generates user-scoped toast stream key", () => {
    expect(toastStream("user-xyz")).toBe("stream:toasts:user-xyz");
  });

  it("generates install-specific stream key", () => {
    expect(installStream("install-001")).toBe("stream:install:install-001");
  });
});

// ---------------------------------------------------------------------------
// Stream config
// ---------------------------------------------------------------------------

describe("getStreamMaxLen", () => {
  beforeEach(() => {
    resetStreamConfig();
    settingsMock.getSystemSettingRaw.mockReset();
  });

  it("returns default 10000 when no setting exists", async () => {
    settingsMock.getSystemSettingRaw.mockResolvedValue(null);
    expect(await getStreamMaxLen()).toBe(10_000);
  });

  it("returns custom value from system settings", async () => {
    settingsMock.getSystemSettingRaw.mockResolvedValue("5000");
    expect(await getStreamMaxLen()).toBe(5_000);
  });

  it("caches the value on subsequent calls", async () => {
    settingsMock.getSystemSettingRaw.mockResolvedValue("8000");
    await getStreamMaxLen();
    await getStreamMaxLen();
    expect(settingsMock.getSystemSettingRaw).toHaveBeenCalledTimes(1);
  });

  it("falls back to default when system settings throws", async () => {
    settingsMock.getSystemSettingRaw.mockRejectedValue(new Error("db down"));
    expect(await getStreamMaxLen()).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// addEvent
// ---------------------------------------------------------------------------

describe("addEvent", () => {
  beforeEach(() => {
    resetStreamConfig();
    settingsMock.getSystemSettingRaw.mockResolvedValue(null);
    redisMock.xadd.mockReset().mockResolvedValue("1234567890-0");
  });

  it("calls XADD on the correct event stream key", async () => {
    const event = {
      type: "deploy.success" as const,
      title: "Deploy complete",
      message: "App deployed",
      projectName: "my-project",
      appId: "app-1",
      deploymentId: "dep-1",
      duration: "12s",
    };

    await addEvent("org-42", event);

    expect(redisMock.xadd).toHaveBeenCalledOnce();
    const args = redisMock.xadd.mock.calls[0];
    expect(args[0]).toBe("stream:events:org-42");
  });

  it("applies approximate MAXLEN trimming", async () => {
    const event = {
      type: "deploy.success" as const,
      title: "Deploy complete",
      message: "ok",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    await addEvent("org-1", event);

    const args = redisMock.xadd.mock.calls[0];
    expect(args[1]).toBe("MAXLEN");
    expect(args[2]).toBe("~");
    expect(args[3]).toBe("10000");
    expect(args[4]).toBe("*");
  });

  it("serializes the event as JSON in the payload field", async () => {
    const event = {
      type: "deploy.success" as const,
      title: "Done",
      message: "msg",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    await addEvent("org-1", event);

    const args = redisMock.xadd.mock.calls[0];
    const fieldIndex = args.indexOf("payload");
    expect(fieldIndex).toBeGreaterThan(-1);
    expect(JSON.parse(args[fieldIndex + 1])).toEqual(event);
  });

  it("includes type and ts fields alongside payload", async () => {
    const event = {
      type: "deploy.success" as const,
      title: "Done",
      message: "msg",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    await addEvent("org-1", event);

    const args = redisMock.xadd.mock.calls[0];
    expect(args).toContain("type");
    expect(args).toContain("deploy.success");
    expect(args).toContain("ts");
  });

  it("returns the stream entry ID", async () => {
    redisMock.xadd.mockResolvedValue("9999-1");
    const event = {
      type: "deploy.success" as const,
      title: "Done",
      message: "msg",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    const id = await addEvent("org-1", event);
    expect(id).toBe("9999-1");
  });

  it("throws when XADD returns null", async () => {
    redisMock.xadd.mockResolvedValue(null);
    const event = {
      type: "deploy.success" as const,
      title: "Done",
      message: "msg",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    await expect(addEvent("org-1", event)).rejects.toThrow("XADD returned null");
  });

  it("uses custom MAXLEN from system settings", async () => {
    settingsMock.getSystemSettingRaw.mockResolvedValue("500");
    const event = {
      type: "deploy.success" as const,
      title: "Done",
      message: "msg",
      projectName: "p",
      appId: "a",
      deploymentId: "d",
      duration: "1s",
    };

    await addEvent("org-1", event);

    const args = redisMock.xadd.mock.calls[0];
    expect(args[3]).toBe("500");
  });
});

// ---------------------------------------------------------------------------
// addDeployLog
// ---------------------------------------------------------------------------

describe("addDeployLog", () => {
  beforeEach(() => {
    resetStreamConfig();
    settingsMock.getSystemSettingRaw.mockResolvedValue(null);
    redisMock.xadd.mockReset().mockResolvedValue("5555-0");
  });

  it("writes to the deploy-specific stream", async () => {
    await addDeployLog("dep-99", { line: "Building...", stage: "build", status: "running" });

    const args = redisMock.xadd.mock.calls[0];
    expect(args[0]).toBe("stream:deploy:dep-99");
  });

  it("includes line, stage, status, and ts fields", async () => {
    await addDeployLog("dep-1", { line: "Step 1/3", stage: "build", status: "running" });

    const args = redisMock.xadd.mock.calls[0];
    const lineIdx = args.indexOf("line");
    const stageIdx = args.indexOf("stage");
    const statusIdx = args.indexOf("status");
    const tsIdx = args.indexOf("ts");

    expect(args[lineIdx + 1]).toBe("Step 1/3");
    expect(args[stageIdx + 1]).toBe("build");
    expect(args[statusIdx + 1]).toBe("running");
    expect(tsIdx).toBeGreaterThan(-1);
    expect(Number(args[tsIdx + 1])).toBeGreaterThan(0);
  });

  it("returns the entry ID", async () => {
    const id = await addDeployLog("dep-1", { line: "done", stage: "push", status: "complete" });
    expect(id).toBe("5555-0");
  });
});

// ---------------------------------------------------------------------------
// addToast
// ---------------------------------------------------------------------------

describe("addToast", () => {
  beforeEach(() => {
    resetStreamConfig();
    settingsMock.getSystemSettingRaw.mockResolvedValue(null);
    redisMock.xadd.mockReset().mockResolvedValue("7777-0");
  });

  it("writes to the user toast stream", async () => {
    await addToast("user-1", {
      toastId: "t-1",
      tier: "temp",
      type: "info",
      title: "Hello",
      message: "World",
    });

    const args = redisMock.xadd.mock.calls[0];
    expect(args[0]).toBe("stream:toasts:user-1");
  });

  it("includes all required toast fields", async () => {
    await addToast("user-1", {
      toastId: "t-2",
      tier: "persistent",
      type: "deploy",
      title: "Deploy done",
      message: "Your app is live",
    });

    const args = redisMock.xadd.mock.calls[0];
    expect(args).toContain("toastId");
    expect(args).toContain("t-2");
    expect(args).toContain("tier");
    expect(args).toContain("persistent");
    expect(args).toContain("type");
    expect(args).toContain("deploy");
    expect(args).toContain("title");
    expect(args).toContain("Deploy done");
    expect(args).toContain("message");
    expect(args).toContain("Your app is live");
  });

  it("includes optional progress field when provided", async () => {
    await addToast("user-1", {
      toastId: "t-3",
      tier: "progress",
      type: "deploy",
      title: "Deploying",
      message: "Step 2 of 5",
      progress: 40,
    });

    const args = redisMock.xadd.mock.calls[0] as string[];
    // Find "progress" as a field name (not as a tier value).
    // Field names are at even offsets after the 5 prefix args (key, MAXLEN, ~, maxLen, *).
    const fieldArgs = args.slice(5);
    let progressValue: string | undefined;
    for (let i = 0; i < fieldArgs.length; i += 2) {
      if (fieldArgs[i] === "progress") {
        progressValue = fieldArgs[i + 1];
        break;
      }
    }
    expect(progressValue).toBe("40");
  });

  it("includes optional status field when provided", async () => {
    await addToast("user-1", {
      toastId: "t-4",
      tier: "progress",
      type: "deploy",
      title: "Done",
      message: "ok",
      status: "complete",
    });

    const args = redisMock.xadd.mock.calls[0];
    expect(args).toContain("status");
    expect(args).toContain("complete");
  });

  it("includes optional action fields when provided", async () => {
    await addToast("user-1", {
      toastId: "t-5",
      tier: "persistent",
      type: "alert",
      title: "Alert",
      message: "Check logs",
      actionUrl: "/logs",
      actionLabel: "View Logs",
    });

    const args = redisMock.xadd.mock.calls[0];
    expect(args).toContain("actionUrl");
    expect(args).toContain("/logs");
    expect(args).toContain("actionLabel");
    expect(args).toContain("View Logs");
  });

  it("omits optional fields when not provided", async () => {
    await addToast("user-1", {
      toastId: "t-6",
      tier: "temp",
      type: "info",
      title: "Hi",
      message: "Simple toast",
    });

    const args = redisMock.xadd.mock.calls[0];
    expect(args).not.toContain("progress");
    expect(args).not.toContain("status");
    expect(args).not.toContain("actionUrl");
    expect(args).not.toContain("actionLabel");
  });
});

// ---------------------------------------------------------------------------
// addInstallEvent
// ---------------------------------------------------------------------------

describe("addInstallEvent", () => {
  beforeEach(() => {
    resetStreamConfig();
    settingsMock.getSystemSettingRaw.mockResolvedValue(null);
    redisMock.xadd.mockReset().mockResolvedValue("8888-0");
  });

  it("writes to the install-specific stream", async () => {
    await addInstallEvent("inst-1", { step: "download", progress: "50" });

    const args = redisMock.xadd.mock.calls[0];
    expect(args[0]).toBe("stream:install:inst-1");
  });

  it("flattens record entries as field pairs", async () => {
    await addInstallEvent("inst-2", { step: "configure", detail: "writing config" });

    const args = redisMock.xadd.mock.calls[0];
    const stepIdx = args.indexOf("step");
    const detailIdx = args.indexOf("detail");
    expect(args[stepIdx + 1]).toBe("configure");
    expect(args[detailIdx + 1]).toBe("writing config");
  });

  it("appends a ts field", async () => {
    await addInstallEvent("inst-3", { step: "done" });

    const args = redisMock.xadd.mock.calls[0];
    expect(args).toContain("ts");
  });

  it("returns the entry ID", async () => {
    const id = await addInstallEvent("inst-4", { step: "done" });
    expect(id).toBe("8888-0");
  });
});
