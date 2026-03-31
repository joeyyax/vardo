import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:update");

type UpdateStatus = {
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  updateAvailable: boolean;
  commits: Array<{
    hash: string;
    message: string;
  }>;
};

// Helper to run a git command and return stdout
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `git ${args[0]} failed with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// GET /api/v1/admin/maintenance/update
//
// Check for updates by comparing local HEAD to origin/main.
export async function GET() {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR;
    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR not configured" },
        { status: 500 }
      );
    }

    // Fetch latest from origin
    await runGit(["fetch", "origin", "main"], vardoDir);

    // Get current commit
    const currentCommit = await runGit(["rev-parse", "HEAD"], vardoDir);

    // Get latest commit on origin/main
    const latestCommit = await runGit(["rev-parse", "origin/main"], vardoDir);

    // Count commits behind
    const behindOutput = await runGit(
      ["rev-list", "--count", `HEAD..origin/main`],
      vardoDir
    );
    const behindBy = parseInt(behindOutput, 10) || 0;

    // Get list of new commits if any
    const commits: UpdateStatus["commits"] = [];
    if (behindBy > 0) {
      const logOutput = await runGit(
        ["log", "--oneline", `HEAD..origin/main`, "--format=%h %s"],
        vardoDir
      );
      for (const line of logOutput.split("\n").filter(Boolean)) {
        const [hash, ...messageParts] = line.split(" ");
        commits.push({ hash, message: messageParts.join(" ") });
      }
    }

    const status: UpdateStatus = {
      currentCommit: currentCommit.slice(0, 7),
      latestCommit: latestCommit.slice(0, 7),
      behindBy,
      updateAvailable: behindBy > 0,
      commits,
    };

    return NextResponse.json(status);
  } catch (error) {
    return handleRouteError(error, "Error checking for updates");
  }
}

// POST /api/v1/admin/maintenance/update
//
// Apply update: git pull, docker compose build, docker compose up -d
export async function POST() {
  try {
    await requireAppAdmin();

    const vardoDir = process.env.VARDO_DIR;
    if (!vardoDir) {
      return NextResponse.json(
        { error: "VARDO_DIR not configured" },
        { status: 500 }
      );
    }

    log.info("applying update", { vardoDir });

    // Pull latest changes
    await runGit(["pull", "origin", "main"], vardoDir);

    // Rebuild and restart in background
    const composePath = `${vardoDir}/docker-compose.yml`;

    setTimeout(() => {
      // Build containers
      const buildProc = spawn("docker", ["compose", "-f", composePath, "build"], {
        cwd: vardoDir,
        env: {
          ...process.env,
          GIT_SHA: "",  // Will be set by build
        },
      });

      buildProc.on("close", (buildCode) => {
        if (buildCode === 0) {
          log.info("build completed, starting services");
          const upProc = spawn("docker", ["compose", "-f", composePath, "up", "-d"], {
            detached: true,
            stdio: "ignore",
            cwd: vardoDir,
          });
          upProc.unref();
        } else {
          log.error("build failed", { code: buildCode });
        }
      });
    }, 1000);

    return NextResponse.json({
      success: true,
      message: "Update started. Vardo will rebuild and restart shortly.",
    });
  } catch (error) {
    return handleRouteError(error, "Error applying update");
  }
}
