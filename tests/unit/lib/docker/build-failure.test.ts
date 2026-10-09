import { describe, it, expect } from "vitest";
import { withFailedStepOutput } from "@/lib/docker/build-failure";

const stderr = [
  "#13 [web 6/9] RUN pnpm install",
  "#13 0.5 Progress: resolved 1",
  "#14 [web 7/9] RUN pnpm install --frozen-lockfile",
  "#14 1.814  ERR_PNPM_FETCH_404  GET https://codeload.github.com/x/y: Not Found - 404",
  "#14 ERROR: process \"/bin/sh -c pnpm install\" did not complete successfully: exit code: 1",
  "target web: failed to solve: process did not complete successfully: exit code: 1",
].join("\n");

describe("withFailedStepOutput", () => {
  it("appends the failed step's tool output to the error", () => {
    const err = Object.assign(new Error("Command failed: docker compose build"), { stderr });
    const out = withFailedStepOutput(err) as Error;
    expect(out.message).toContain("ERR_PNPM_FETCH_404");
    expect(out.message).not.toContain("Progress: resolved");
  });

  it("keeps only the last lines", () => {
    const many = Array.from({ length: 40 }, (_, i) => `#9 ${i}.1 line${i}`).join("\n");
    const err = Object.assign(new Error("x"), { stderr: `${many}\n#9 ERROR: failed` });
    const msg = (withFailedStepOutput(err) as Error).message;
    expect(msg).toContain("line39");
    expect(msg).not.toContain("line10\n");
  });

  it("leaves errors without a failed step alone", () => {
    const err = Object.assign(new Error("boom"), { stderr: "#1 0.1 hi" });
    expect((withFailedStepOutput(err) as Error).message).toBe("boom");
    expect(withFailedStepOutput("str")).toBe("str");
  });
});
