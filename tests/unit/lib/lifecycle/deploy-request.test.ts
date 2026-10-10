import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));

const { processDeployRequest, parseDeployRequest, REQUEST_FILE, RESULT_FILE } = await import("@/lib/lifecycle/deploy-request");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vardo-requests-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const result = async () => JSON.parse(await readFile(join(dir, RESULT_FILE), "utf-8"));

describe("parseDeployRequest", () => {
  it("takes a plain id only", () => {
    expect(parseDeployRequest('{"id":"20261009170000-4242"}')).toEqual({ id: "20261009170000-4242" });
    expect(parseDeployRequest('{"id":"../../etc"}')).toBeNull();
    expect(parseDeployRequest("nope")).toBeNull();
  });
});

describe("processDeployRequest", () => {
  it("does nothing without a request", async () => {
    const trigger = vi.fn();
    expect(await processDeployRequest(dir, trigger)).toBeNull();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("claims a request once and answers with the deployment", async () => {
    await writeFile(join(dir, REQUEST_FILE), '{"id":"req-1"}');
    const trigger = vi.fn().mockResolvedValue({ deploymentId: "dep_123" });

    const [first, second] = await Promise.all([processDeployRequest(dir, trigger), processDeployRequest(dir, trigger)]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(trigger).toHaveBeenCalledOnce();
    expect(await result()).toMatchObject({ id: "req-1", state: "accepted", deploymentId: "dep_123" });
    expect(await readdir(dir)).toEqual([RESULT_FILE]);
  });

  it("answers with the reason a deploy was refused", async () => {
    await writeFile(join(dir, REQUEST_FILE), '{"id":"req-2"}');
    const trigger = vi.fn().mockRejectedValue(new Error("Vardo is restarting to finish an update"));
    await processDeployRequest(dir, trigger);
    expect(await result()).toMatchObject({ id: "req-2", state: "refused", error: "Vardo is restarting to finish an update" });
  });

  it("refuses a malformed request without deploying", async () => {
    await writeFile(join(dir, REQUEST_FILE), "garbage");
    const trigger = vi.fn();
    await processDeployRequest(dir, trigger);
    expect(trigger).not.toHaveBeenCalled();
    expect(await result()).toMatchObject({ state: "refused" });
  });
});
