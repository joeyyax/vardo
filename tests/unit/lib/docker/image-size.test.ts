import { describe, it, expect } from "vitest";
import { imagesBytes } from "@/lib/docker/image-size";

describe("imagesBytes", () => {
  it("sums each image's size from one inspect", async () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[]) => (calls.push(args), { stdout: "1000\n2500\n" });
    expect(await imagesBytes(["web:1", "api:1"], exec)).toBe(3500);
    expect(calls).toEqual([["image", "inspect", "--format", "{{.Size}}", "web:1", "api:1"]]);
  });

  it("is null when an image is missing or docker fails", async () => {
    expect(await imagesBytes(["web:1", "api:1"], async () => ({ stdout: "1000\n" }))).toBeNull();
    expect(await imagesBytes(["web:1"], async () => { throw new Error("No such image"); })).toBeNull();
    expect(await imagesBytes([])).toBeNull();
  });
});
