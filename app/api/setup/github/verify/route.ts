import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { createAppAuth } from "@octokit/auth-app";

export async function POST() {
  try {
    await requireAdminAuth();
  } catch {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const config = await getGitHubAppConfig();
  if (!config?.appId || !config?.privateKey) {
    return NextResponse.json({
      ok: false,
      message: "GitHub App is not configured — save your credentials first",
    });
  }

  try {
    const auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });

    const { token } = await auth({ type: "app" });

    const res = await fetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json({
        ok: false,
        message: `GitHub API returned ${res.status}: ${body.message ?? "unknown error"}`,
      });
    }

    const app = (await res.json()) as { name?: string; slug?: string };
    return NextResponse.json({
      ok: true,
      message: `Connected to GitHub App "${app.name ?? app.slug ?? config.appSlug}"`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // Common: bad private key format
    if (msg.includes("secretOrPrivateKey") || msg.includes("PEM")) {
      return NextResponse.json({
        ok: false,
        message: "Invalid private key — check that you pasted the full PEM including headers",
      });
    }
    return NextResponse.json({ ok: false, message: `Verification failed: ${msg}` });
  }
}
