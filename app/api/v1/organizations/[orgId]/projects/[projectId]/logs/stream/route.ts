import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { spawn } from "child_process";
import { resolve } from "path";
import { readFile } from "fs/promises";

const PROJECTS_DIR = resolve(process.env.HOST_PROJECTS_DIR || "./.host/projects");

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/logs/stream
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return new Response("Forbidden", { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const tail = searchParams.get("tail") || "200";

    // Find the active slot
    const projectDir = resolve(PROJECTS_DIR, project.name);
    let activeSlot = "blue";
    try {
      activeSlot = (await readFile(resolve(projectDir, ".active-slot"), "utf-8")).trim();
    } catch { /* default to blue */ }

    const slotDir = resolve(projectDir, activeSlot);
    const composePath = resolve(slotDir, "docker-compose.yml");
    const composeProject = `${project.name}-${activeSlot}`;

    // Create SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Spawn docker compose logs -f
        const proc = spawn("docker", [
          "compose",
          "-f", composePath,
          "-p", composeProject,
          "logs",
          "-f",
          "--tail", tail,
          "--no-log-prefix",
        ], { cwd: slotDir });

        function send(data: string) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            proc.kill();
          }
        }

        proc.stdout.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            if (line) send(line);
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            if (line) send(line);
          }
        });

        proc.on("error", (err) => {
          send(`[error] ${err.message}`);
          controller.close();
        });

        proc.on("close", () => {
          try { controller.close(); } catch { /* already closed */ }
        });

        // Clean up when client disconnects
        request.signal.addEventListener("abort", () => {
          proc.kill();
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return new Response("Unauthorized", { status: 401 });
    }
    console.error("Error streaming logs:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
