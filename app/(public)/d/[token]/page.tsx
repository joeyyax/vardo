"use client";

import { useState, useEffect, use } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

type DocumentSection = {
  id: string;
  type: string;
  title: string;
  content: string;
  order: number;
};

type Document = {
  id: string;
  type: "proposal" | "contract";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  content: {
    sections: DocumentSection[];
  };
  requiresContract: boolean;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  project: {
    name: string;
  };
  organization: {
    name: string;
  };
  createdBy: {
    name: string | null;
    email: string;
  } | null;
};

type Props = {
  params: Promise<{ token: string }>;
};

export default function PublicDocumentPage({ params }: Props) {
  const { token } = use(params);
  const [document, setDocument] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false);
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    async function fetchDocument() {
      try {
        const response = await fetch(`/api/documents/${token}`);
        if (response.ok) {
          const data = await response.json();
          setDocument(data);
        } else {
          const err = await response.json();
          setError(err.error || "Document not found");
        }
      } catch {
        setError("Failed to load document");
      } finally {
        setIsLoading(false);
      }
    }

    fetchDocument();
  }, [token]);

  async function handleAccept() {
    if (!email.trim() || !email.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/documents/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "accept",
          email: email.trim(),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setDocument((prev) =>
          prev ? { ...prev, status: "accepted", acceptedAt: new Date().toISOString() } : null
        );
        setAcceptDialogOpen(false);
        toast.success(`${document?.type === "proposal" ? "Proposal" : "Contract"} accepted`);
      } else {
        const err = await response.json();
        toast.error(err.error || "Failed to accept document");
      }
    } catch {
      toast.error("Failed to accept document");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDecline() {
    if (!email.trim() || !email.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/documents/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decline",
          email: email.trim(),
          reason: declineReason.trim() || undefined,
        }),
      });

      if (response.ok) {
        setDocument((prev) =>
          prev ? { ...prev, status: "declined", declinedAt: new Date().toISOString() } : null
        );
        setDeclineDialogOpen(false);
        toast.success(`${document?.type === "proposal" ? "Proposal" : "Contract"} declined`);
      } else {
        const err = await response.json();
        toast.error(err.error || "Failed to decline document");
      }
    } catch {
      toast.error("Failed to decline document");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !document) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="squircle max-w-md w-full mx-4">
          <CardContent className="py-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900">
              <XCircle className="size-6 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Document Not Found</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {error || "This document may have been removed or the link is invalid."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isFinalized = document.status === "accepted" || document.status === "declined";

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Header */}
      <header className="border-b bg-background">
        <div className="container max-w-4xl mx-auto px-4 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">
                {document.organization.name}
              </p>
              <h1 className="text-2xl font-semibold mt-1">{document.title}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                {document.type === "proposal" ? "Proposal" : "Contract"} for {document.project.name}
              </p>
            </div>
            <div className="text-right shrink-0">
              {document.status === "accepted" && (
                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="size-5" />
                  <span className="font-medium">Accepted</span>
                </div>
              )}
              {document.status === "declined" && (
                <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                  <XCircle className="size-5" />
                  <span className="font-medium">Declined</span>
                </div>
              )}
              {document.sentAt && !isFinalized && (
                <p className="text-xs text-muted-foreground mt-1">
                  Sent {formatDistanceToNow(new Date(document.sentAt), { addSuffix: true })}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="container max-w-4xl mx-auto px-4 py-8">
        <div className="space-y-6">
          {document.content.sections
            .sort((a, b) => a.order - b.order)
            .map((section) => (
              <Card key={section.id} className="squircle">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{section.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
                    {section.content || (
                      <span className="text-muted-foreground italic">No content</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>

        {/* Actions */}
        {!isFinalized && (
          <div className="mt-8 flex items-center justify-center gap-4">
            <Button
              variant="outline"
              size="lg"
              onClick={() => setDeclineDialogOpen(true)}
              className="squircle"
            >
              <XCircle className="size-4" />
              Decline
            </Button>
            <Button
              size="lg"
              onClick={() => setAcceptDialogOpen(true)}
              className="squircle"
            >
              <CheckCircle2 className="size-4" />
              Accept {document.type === "proposal" ? "Proposal" : "Contract"}
            </Button>
          </div>
        )}

        {/* Footer */}
        {document.createdBy && (
          <div className="mt-12 text-center text-sm text-muted-foreground">
            <p>
              Prepared by {document.createdBy.name || document.createdBy.email}
            </p>
          </div>
        )}
      </main>

      {/* Accept Dialog */}
      <Dialog open={acceptDialogOpen} onOpenChange={setAcceptDialogOpen}>
        <DialogContent className="squircle">
          <DialogHeader>
            <DialogTitle>Accept {document.type === "proposal" ? "Proposal" : "Contract"}</DialogTitle>
            <DialogDescription>
              Please confirm your acceptance by entering your email address.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="accept-email">Your Email</Label>
              <Input
                id="accept-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="squircle"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAcceptDialogOpen(false)}
              disabled={isSubmitting}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAccept}
              disabled={isSubmitting || !email.trim()}
              className="squircle"
            >
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline Dialog */}
      <Dialog open={declineDialogOpen} onOpenChange={setDeclineDialogOpen}>
        <DialogContent className="squircle">
          <DialogHeader>
            <DialogTitle>Decline {document.type === "proposal" ? "Proposal" : "Contract"}</DialogTitle>
            <DialogDescription>
              Please provide your email and optionally a reason for declining.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="decline-email">Your Email</Label>
              <Input
                id="decline-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="squircle"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decline-reason">Reason (optional)</Label>
              <Textarea
                id="decline-reason"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                placeholder="Let us know why you're declining..."
                rows={3}
                className="squircle resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeclineDialogOpen(false)}
              disabled={isSubmitting}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDecline}
              disabled={isSubmitting || !email.trim()}
              className="squircle"
            >
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
