"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, Copy, Mail } from "lucide-react";
import { toast } from "sonner";

type IntakeEmailPopoverProps = {
  orgId: string;
  projectId?: string;
  intakeEmailToken?: string | null;
};

export function IntakeEmailPopover({
  orgId,
  projectId,
  intakeEmailToken,
}: IntakeEmailPopoverProps) {
  const [email, setEmail] = useState<string | null>(
    intakeEmailToken ? `${intakeEmailToken}@intake.usescope.net` : null
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const tokenUrl = projectId
    ? `/api/v1/organizations/${orgId}/projects/${projectId}/intake-token`
    : `/api/v1/organizations/${orgId}/inbox/token`;

  async function handleGenerate() {
    setIsGenerating(true);
    try {
      const res = await fetch(tokenUrl, { method: "POST" });
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
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="squircle">
          <Mail className="size-4" />
          Email Intake
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 squircle">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Email Intake</p>
            <p className="text-xs text-muted-foreground mt-1">
              Forward receipts, invoices, and documents to this address.
              PDF and image attachments appear in your Inbox for review.
            </p>
          </div>
          {email ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-md border bg-muted/50 px-3 py-2">
                <code className="text-xs break-all">{email}</code>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopy}
                className="shrink-0 size-8"
              >
                {copied ? (
                  <Check className="size-3.5 text-green-600" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full squircle"
            >
              <Mail className="size-4" />
              {isGenerating ? "Generating..." : "Generate Email Address"}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
