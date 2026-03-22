import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";

// POST /api/v1/github/webhook — GitHub App webhook receiver
export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const event = request.headers.get("x-github-event");
    const signature = request.headers.get("x-hub-signature-256");
    const deliveryId = request.headers.get("x-github-delivery");

    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.BETTER_AUTH_SECRET;
    if (secret && signature) {
      const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
      if (signature !== expected) {
        console.error("[webhook] Invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

    const payload = JSON.parse(body);

    // Only handle push events
    if (event !== "push") {
      return NextResponse.json({ ok: true, skipped: event });
    }

    const repoFullName = payload.repository?.full_name;
    const branch = payload.ref?.replace("refs/heads/", "");
    const commitSha = payload.after;
    const commitMessage = payload.head_commit?.message;
    const pusher = payload.pusher?.name || payload.sender?.login;

    if (!repoFullName || !branch) {
      return NextResponse.json({ ok: true, skipped: "missing repo or branch" });
    }

    console.log(`[webhook] Push to ${repoFullName}:${branch} by ${pusher} — ${commitSha?.slice(0, 7)} ${commitMessage?.split("\n")[0]}`);

    // Find all projects that match this repo + branch with autoDeploy enabled
    const gitUrl = `https://github.com/${repoFullName}.git`;
    const allProjects = await db.query.projects.findMany({
      where: and(
        eq(projects.gitUrl, gitUrl),
        eq(projects.autoDeploy, true)
      ),
    });

    // Filter to matching branch
    const matching = allProjects.filter(
      (p) => (p.gitBranch || "main") === branch
    );

    if (matching.length === 0) {
      console.log(`[webhook] No auto-deploy projects for ${repoFullName}:${branch}`);
      return NextResponse.json({ ok: true, skipped: "no matching projects" });
    }

    // Trigger deploys
    const results = [];
    for (const project of matching) {
      console.log(`[webhook] Auto-deploying ${project.displayName} (${project.name})`);
      try {
        const result = await deployProject({
          projectId: project.id,
          organizationId: project.organizationId,
          trigger: "webhook",
        });
        results.push({
          project: project.name,
          deploymentId: result.deploymentId,
          success: result.success,
        });
      } catch (err) {
        results.push({
          project: project.name,
          error: err instanceof Error ? err.message : "Deploy failed",
        });
      }
    }

    return NextResponse.json({ ok: true, deployments: results });
  } catch (error) {
    console.error("[webhook] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
