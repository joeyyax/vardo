"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { slugify } from "@/lib/ui/slugify";

export function NewProjectForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(value: string) {
    setDisplayName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlugEdited(true);
    setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!slug.trim()) {
      toast.error("Slug is required");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: slug,
            displayName: displayName.trim(),
            description: description.trim() || undefined,
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create project");
        return;
      }

      toast.success("Project created");
      router.push(`/projects/${slug}`);
    } catch {
      toast.error("Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-6">
      <div className="squircle rounded-lg border bg-card p-6 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="displayName">Name</Label>
          <Input
            id="displayName"
            placeholder="My Project"
            value={displayName}
            onChange={(e) => handleNameChange(e.target.value)}
            required
            className="squircle"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            placeholder="my-project"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            required
            className="squircle font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Auto-generated from name. Used in URLs and API references.
          </p>
        </div>


        <div className="space-y-2">
          <Label htmlFor="description">
            Description <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="description"
            placeholder="A brief description of this project..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="squircle"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting || !slug.trim()} className="squircle">
          {submitting ? "Creating..." : "Create Project"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          className="squircle"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
