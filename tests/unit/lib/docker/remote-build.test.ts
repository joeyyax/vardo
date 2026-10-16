import { describe, it, expect } from "vitest";
import { bringBack } from "@/lib/docker/remote-build";
import { BuilderError } from "@/lib/docker/build-targets";

// Bringing a target's image here: push there, pull here, drop the registry tags on both sides.

const session = { env: { DOCKER_HOST: "ssh://vardo@lh:22", PATH: "/tmp/s/bin:/usr/bin" }, close: async () => {} };

function recorder(fail?: (args: string[]) => boolean) {
  const calls: { args: string[]; where: string }[] = [];
  const exec = async (_cmd: string, args: string[], opts: Record<string, unknown>) => {
    const env = opts.env as NodeJS.ProcessEnv;
    calls.push({ args, where: env.DOCKER_HOST ? "there" : "here" });
    if (fail?.(args)) throw Object.assign(new Error("failed"), { stderr: "unauthorized: authentication required" });
    return { stdout: "" };
  };
  return { calls, exec };
}

describe("bringBack", () => {
  it("pushes from the target, pulls here under the image's name and untags the ref on both", async () => {
    const { calls, exec } = recorder();
    const lines: string[] = [];
    await bringBack([{ image: "shop:deploy-1", ref: "reg/shop:k1" }], {
      authEnv: { DOCKER_CONFIG: "/tmp/auth" } as unknown as NodeJS.ProcessEnv, session, log: (l) => lines.push(l), exec,
    });
    expect(calls.map((c) => `${c.where} ${c.args.join(" ")}`)).toEqual([
      "there tag shop:deploy-1 reg/shop:k1",
      "there push --quiet reg/shop:k1",
      "there image rm reg/shop:k1 shop:deploy-1",
      "here pull --quiet reg/shop:k1",
      "here tag reg/shop:k1 shop:deploy-1",
      "here image rm reg/shop:k1",
    ]);
    expect(lines[0]).toMatch(/^\[build\] Pulled reg\/shop:k1 from the build registry as shop:deploy-1/);
  });

  it("blames the builder when the push fails, and still cleans up there", async () => {
    const { calls, exec } = recorder((args) => args[0] === "push");
    await expect(bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv: {} as NodeJS.ProcessEnv, session, log: () => {}, exec }))
      .rejects.toBeInstanceOf(BuilderError);
    expect(calls.at(-1)).toEqual({ args: ["image", "rm", "reg/shop:k", "shop:d"], where: "there" });
    expect(calls.some((c) => c.args[0] === "pull")).toBe(false);
  });

  it("blames the builder when the pull here fails", async () => {
    const { exec } = recorder((args) => args[0] === "pull");
    await expect(bringBack([{ image: "shop:d", ref: "reg/shop:k" }], { authEnv: {} as NodeJS.ProcessEnv, session, log: () => {}, exec }))
      .rejects.toMatchObject({ reason: expect.stringMatching(/^couldn't pull reg\/shop:k here: unauthorized/) });
  });
});
