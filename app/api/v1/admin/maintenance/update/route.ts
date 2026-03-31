import { NextResponse } from "next/server";
import { spawn, execFileSync } from "child_process";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:update");

// POST /api/v1/admin/maintenance/update
//
// Pulls latest code from git, rebuilds the frontend image, and restarts
// the stack. The git pull runs synchronously so any fetch errors surface
// immediately. The rebuild + restart run detached in the background — the
// container will restart itself once the new image is ready.
export async function POST() {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR;

    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR is not set — cannot run git pull or docker compose without knowing the installation path" },
        { status: 503 },
      );
    }

    // git pull — run synchronously so we can report fetch errors immediately
    try {
      const pullOutput = execFileSync("git", ["-C", vardoDir, "pull"], { timeout: 30000 }).toString().trim();
      log.info(`git pull: ${pullOutput}`);
    } catch (err) {
      log.error(`git pull failed: ${err}`);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "git pull failed" },
        { status: 500 },
      );
    }

    // Rebuild + restart detached — the container will go down as part of up -d
    log.info("rebuilding and restarting stack in background");

    setTimeout(() => {
      const build = spawn(
        "docker",
        ["compose", "-f", `${vardoDir}/docker-compose.yml`, "build", "frontend"],
        { detached: true, stdio: "ignore" },
      );
      build.unref();

      build.on("close", (code) => {
        if (code !== 0) {
          log.error(`docker compose build exited with code ${code}`);
          return;
        }
        spawn(
          "docker",
          ["compose", "-f", `${vardoDir}/docker-compose.yml`, "up", "-d"],
          { detached: true, stdio: "ignore" },
        ).unref();
      });
    }, 500);

    return NextResponse.json({
      ok: true,
      message: "Update initiated — rebuilding and restarting in the background.",
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
