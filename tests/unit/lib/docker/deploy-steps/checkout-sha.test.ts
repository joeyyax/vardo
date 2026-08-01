import { describe, it, expect, vi } from "vitest";
import { checkoutRollbackSha, type GitRunner } from "@/lib/docker/deploy-steps/checkout-sha";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

/**
 * Fake git: `present` lists the commits the clone can resolve, `fetchable`
 * the ones a fetch can bring in.
 */
function fakeGit(opts: { present?: string[]; fetchable?: string[] } = {}) {
  const present = new Set(opts.present ?? []);
  const fetchable = new Set(opts.fetchable ?? []);
  const calls: string[][] = [];

  const git: GitRunner = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "cat-file") {
      const sha = args[2].replace("^{commit}", "");
      if (!present.has(sha)) throw new Error(`fatal: Not a valid object name ${sha}`);
      return { stdout: "" };
    }
    if (cmd === "fetch") {
      const wanted = args[args.length - 1];
      if (fetchable.has(wanted)) present.add(wanted);
      else if (args.includes("--unshallow")) for (const s of fetchable) present.add(s);
      else throw new Error("fatal: could not fetch");
      return { stdout: "" };
    }
    if (cmd === "checkout") return { stdout: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  return { git, calls };
}

describe("checkoutRollbackSha", () => {
  it("checks out a commit already in the clone without fetching", async () => {
    const { git, calls } = fakeGit({ present: [SHA] });
    const log = vi.fn();

    await checkoutRollbackSha(git, SHA, log);

    expect(calls.some((c) => c[0] === "fetch")).toBe(false);
    expect(calls).toContainEqual(["checkout", "--force", "--detach", SHA]);
  });

  it("fetches the commit when the shallow clone lacks it", async () => {
    const { git, calls } = fakeGit({ fetchable: [SHA] });

    await checkoutRollbackSha(git, SHA, vi.fn());

    expect(calls).toContainEqual(["fetch", "--depth", "1", "origin", SHA]);
    expect(calls).toContainEqual(["checkout", "--force", "--detach", SHA]);
  });

  it("falls back to --unshallow when fetching the bare sha fails", async () => {
    const present: string[] = [];
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === "cat-file") {
        if (!present.includes(SHA)) throw new Error("missing");
        return { stdout: "" };
      }
      if (args[0] === "fetch") {
        if (args.includes("--unshallow")) {
          present.push(SHA);
          return { stdout: "" };
        }
        throw new Error("server does not allow request for unadvertised object");
      }
      return { stdout: "" };
    };

    await checkoutRollbackSha(git, SHA, vi.fn());

    expect(calls).toContainEqual(["fetch", "--unshallow", "origin"]);
    expect(calls).toContainEqual(["checkout", "--force", "--detach", SHA]);
  });

  it("throws instead of deploying HEAD when the commit is unreachable", async () => {
    const { git, calls } = fakeGit();

    await expect(checkoutRollbackSha(git, SHA, vi.fn())).rejects.toThrow(
      /not available in the repository/,
    );
    expect(calls.some((c) => c[0] === "checkout")).toBe(false);
  });

  it("rejects a sha that isn't a plain hex object name", async () => {
    const { git, calls } = fakeGit({ present: ["--upload-pack=touch /tmp/pwn"] });

    await expect(checkoutRollbackSha(git, "--upload-pack=touch /tmp/pwn", vi.fn())).rejects.toThrow(
      /Invalid git SHA/,
    );
    expect(calls).toHaveLength(0);
  });
});
