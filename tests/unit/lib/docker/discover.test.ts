import { describe, it, expect } from "vitest";
import { filterImageInheritedEnv } from "@/lib/docker/discover";

describe("filterImageInheritedEnv", () => {
  it("removes vars that are identical in the image", () => {
    const imageEnv = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
    ];
    const containerEnv = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8",
      "MY_SECRET=hunter2",
    ];
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "MY_SECRET=hunter2",
    ]);
  });

  it("keeps vars with the same key but a different value (explicit override)", () => {
    const imageEnv = ["PATH=/usr/bin:/bin"];
    const containerEnv = ["PATH=/usr/local/bin:/usr/bin:/bin", "APP_ENV=production"];
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "APP_ENV=production",
    ]);
  });

  it("returns all vars when imageEnv is empty (fallback path)", () => {
    const containerEnv = ["PATH=/usr/bin", "SECRET=abc"];
    expect(filterImageInheritedEnv(containerEnv, [])).toEqual(containerEnv);
  });

  it("returns empty array when both lists are empty", () => {
    expect(filterImageInheritedEnv([], [])).toEqual([]);
  });

  it("returns empty array when all container vars are inherited", () => {
    const env = ["PATH=/usr/bin", "LANG=C"];
    expect(filterImageInheritedEnv(env, env)).toEqual([]);
  });

  it("handles vars without an equals sign gracefully", () => {
    const imageEnv = ["PATH=/usr/bin"];
    const containerEnv = ["PATH=/usr/bin", "NOVALUE", "KEY=val"];
    // "NOVALUE" is not in imageEnv set → kept
    expect(filterImageInheritedEnv(containerEnv, imageEnv)).toEqual([
      "NOVALUE",
      "KEY=val",
    ]);
  });
});
