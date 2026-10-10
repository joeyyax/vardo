"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import type { IntegrationIssue, IssueCopy } from "@/lib/integrations/issues";

type Issue = IntegrationIssue & { copy: IssueCopy };

const ENDPOINT = "/api/v1/admin/integrations";

/** Permissions the App or an installation still needs, each with the GitHub page that grants them. */
export function PermissionIssues() {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(ENDPOINT)
      .then((res) => (res.ok ? (res.json() as Promise<{ issues: Issue[] }>) : null))
      .then((data) => {
        if (alive && data) setIssues(data.issues);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function checkAgain() {
    setChecking(true);
    try {
      const res = await fetch(ENDPOINT, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { issues?: Issue[]; message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't check GitHub");
        return;
      }
      if (data.issues) setIssues(data.issues);
      toast.success(data.message ?? "Checked");
    } catch {
      toast.error("Couldn't check GitHub");
    } finally {
      setChecking(false);
    }
  }

  if (issues === null) return null;

  const recheck = (
    <Button type="button" size="sm" variant="outline" disabled={checking} onClick={() => void checkAgain()}>
      {checking && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      Check again
    </Button>
  );

  if (issues.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-status-success" aria-hidden="true" />
        <span>The App and its installations have every permission Vardo needs.</span>
        {recheck}
      </div>
    );
  }

  return (
    <div className="space-y-3" role="status" aria-live="polite">
      {issues.map((issue) => (
        <Card key={issue.key}>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="font-medium text-status-warning">{issue.copy.title}</p>
              <p className="text-sm">{issue.copy.message}</p>
              {issue.copy.degraded && <p className="text-sm text-muted-foreground">{issue.copy.degraded}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <a href={issue.fixUrl} target="_blank" rel="noopener noreferrer">
                  {issue.copy.actionLabel}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
              {recheck}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
