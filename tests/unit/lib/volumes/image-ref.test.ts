// An image name reaches `docker run` as an argument, so one that reads as a flag is refused.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }));
vi.mock("@/lib/utils/exec", async (original) => ({
  ...(await original<typeof import("@/lib/utils/exec")>()),
  execFileAsync: execFileAsyncMock,
}));

import { syncFilesFromImage } from "@/lib/volumes/diff";
import { imageRefSchema } from "@/lib/api/create-app-schema";

beforeEach(() => {
  execFileAsyncMock.mockReset();
  execFileAsyncMock.mockResolvedValue({ stdout: "OK:a.txt\n", stderr: "" });
});

describe("syncFilesFromImage", () => {
  it.each(["--privileged", "-v/:/host", "--volume=/:/host"])("refuses %s before running docker", async (image) => {
    await expect(syncFilesFromImage(image, "blog_data", "/data", ["a.txt"])).rejects.toThrow(/Invalid image/);
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it("runs a normal image", async () => {
    await expect(syncFilesFromImage("ghcr.io/example/app:1.2", "blog_data", "/data", ["a.txt"])).resolves.toEqual({
      synced: ["a.txt"],
      failed: [],
    });
  });
});

describe("imageRefSchema", () => {
  it.each(["--privileged", "-v/:/host", "nginx latest", "nginx;id", ""])("refuses %j", (image) => {
    expect(imageRefSchema.safeParse(image).success).toBe(false);
  });

  it.each(["nginx", "nginx:alpine", "ghcr.io/example/app:1.2", "registry.example.com:5000/a/b@sha256:abc"])(
    "accepts %s",
    (image) => {
      expect(imageRefSchema.safeParse(image).success).toBe(true);
    },
  );
});
