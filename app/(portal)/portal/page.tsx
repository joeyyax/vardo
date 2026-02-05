"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Folder, ArrowRight, Clock, RefreshCw } from "lucide-react";

type PortalProject = {
  id: string;
  name: string;
  clientName: string;
  organizationName: string;
  role: "viewer" | "contributor";
  visibility: {
    show_rates: boolean;
    show_time: boolean;
    show_costs: boolean;
  };
};

export default function PortalPage() {
  const [projects, setProjects] = useState<PortalProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const response = await fetch("/api/portal/projects");
        if (!response.ok) {
          throw new Error("Failed to fetch projects");
        }
        const data = await response.json();
        setProjects(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setIsLoading(false);
      }
    }

    fetchProjects();
  }, []);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg border bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
            className="mt-4 squircle"
          >
            <RefreshCw className="size-4" />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Your Projects</h1>
        <p className="text-muted-foreground">
          Projects you have been invited to collaborate on.
        </p>
      </div>

      {projects.length === 0 ? (
        <Card className="squircle">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <Folder className="size-6 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">No projects yet</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              You haven't been invited to any projects. When someone invites
              you, those projects will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <Link key={project.id} href={`/portal/${project.id}`}>
              <Card className="squircle h-full transition-colors hover:bg-accent/50">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-lg">{project.name}</CardTitle>
                    <Badge
                      variant={project.role === "contributor" ? "default" : "secondary"}
                      className="squircle"
                    >
                      {project.role === "contributor" ? "Contributor" : "Viewer"}
                    </Badge>
                  </div>
                  <CardDescription>
                    {project.clientName} &middot; {project.organizationName}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      {project.visibility.show_time && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-4" />
                          Time visible
                        </span>
                      )}
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
