"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";

export default function CreateOrgPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isPending && !session) {
      router.replace("/login");
    }
  }, [session, isPending, router]);

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const res = await fetch("/api/v1/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: orgName, slug }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error("Couldn't create organization", {
          description: data.error || "Check the name and try again",
        });
        return;
      }

      toast.success("Organization created");
      router.push("/projects");
    } catch {
      toast.error("Couldn't create organization", {
        description: "Check your connection and try again",
      });
    } finally {
      setLoading(false);
    }
  }

  if (isPending || !session) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Create an organization
          </h1>
          <p className="text-sm text-muted-foreground">
            Organizations group your apps and team together.
          </p>
        </div>

        <form onSubmit={handleCreateOrg} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="orgName">Organization name</Label>
            <Input
              id="orgName"
              placeholder="e.g. My Team"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
