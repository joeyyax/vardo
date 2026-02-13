"use client";

import { useState } from "react";
import { Copy, Check, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type IntakeEmailSettingsProps = {
  organizationId: string;
  intakeEmailToken: string | null;
  canEdit: boolean;
  /** Entity type for the intake email. Defaults to "organization". */
  entityType?: "organization" | "client" | "project";
  /** Entity ID (clientId or projectId). Required when entityType is not "organization". */
  entityId?: string;
};

const DESCRIPTIONS: Record<string, string> = {
  organization:
    "Forward invoices, receipts, and business records to this address. Attachments appear in your Inbox for review.",
  client:
    "Forward documents for this client to this address. Files will be automatically associated with this client.",
  project:
    "Forward documents for this project to this address. Files will be automatically associated with this project.",
};

export function IntakeEmailSettings({
  organizationId,
  intakeEmailToken,
  canEdit,
  entityType = "organization",
  entityId,
}: IntakeEmailSettingsProps) {
  const [email, setEmail] = useState<string | null>(
    intakeEmailToken ? `${intakeEmailToken}@intake.usescope.net` : null
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  function getTokenUrl(): string {
    const base = `/api/v1/organizations/${organizationId}`;
    switch (entityType) {
      case "client":
        return `${base}/clients/${entityId}/intake-token`;
      case "project":
        return `${base}/projects/${entityId}/intake-token`;
      default:
        return `${base}/inbox/token`;
    }
  }

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const res = await fetch(getTokenUrl(), { method: "POST" });
      if (!res.ok) throw new Error("Failed to generate");
      const data = await res.json();
      setEmail(data.email);
      toast.success("Intake email address generated");
    } catch {
      toast.error("Failed to generate intake email");
    } finally {
      setIsGenerating(false);
    }
  }

  function handleCopy() {
    if (!email) return;
    navigator.clipboard.writeText(email);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Email Intake</h3>
        <p className="text-sm text-muted-foreground">
          {DESCRIPTIONS[entityType]}
        </p>
      </div>

      {email ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-md border bg-muted/50 px-3 py-2">
            <code className="text-sm break-all">{email}</code>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={handleCopy}
            className="shrink-0"
          >
            {copied ? (
              <Check className="size-4 text-green-600" />
            ) : (
              <Copy className="size-4" />
            )}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={handleGenerate}
          disabled={!canEdit || isGenerating}
        >
          <Mail className="mr-2 size-4" />
          {isGenerating ? "Generating..." : "Generate Intake Email"}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        Only PDF and image attachments are processed. Emails without valid
        attachments are ignored. Nothing becomes an expense automatically.
      </p>
    </div>
  );
}
