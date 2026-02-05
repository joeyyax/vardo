"use client";

import { useState, useCallback } from "react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  MoreVertical,
  Plus,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type SectionType = "intro" | "scope" | "deliverables" | "timeline" | "pricing" | "terms" | "custom";

type DocumentSection = {
  id: string;
  type: SectionType;
  title: string;
  content: string;
  order: number;
};

type DocumentContent = {
  sections: DocumentSection[];
  pricing?: {
    type: "fixed" | "hourly" | "retainer";
    amount?: number;
    rate?: number;
    estimatedHours?: number;
  };
};

type Document = {
  id: string;
  type: "proposal" | "contract";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  content: DocumentContent;
  requiresContract: boolean;
  publicToken: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
};

type DocumentEditorProps = {
  document: Document;
  orgId: string;
  projectId: string;
  onSave?: (document: Document) => void;
  onSend?: (document: Document) => void;
};

const SECTION_TYPES: { value: SectionType; label: string }[] = [
  { value: "intro", label: "Introduction" },
  { value: "scope", label: "Scope of Work" },
  { value: "deliverables", label: "Deliverables" },
  { value: "timeline", label: "Timeline" },
  { value: "pricing", label: "Pricing" },
  { value: "terms", label: "Terms & Conditions" },
  { value: "custom", label: "Custom Section" },
];

const DEFAULT_TITLES: Record<SectionType, string> = {
  intro: "Introduction",
  scope: "Scope of Work",
  deliverables: "Deliverables",
  timeline: "Timeline",
  pricing: "Pricing",
  terms: "Terms & Conditions",
  custom: "Custom Section",
};

export function DocumentEditor({
  document: initialDocument,
  orgId,
  projectId,
  onSave,
  onSend,
}: DocumentEditorProps) {
  const [document, setDocument] = useState(initialDocument);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [deleteSection, setDeleteSection] = useState<DocumentSection | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const isReadOnly = document.status !== "draft";
  const sections = document.content.sections || [];

  const updateDocument = useCallback((updates: Partial<Document>) => {
    setDocument((prev) => ({ ...prev, ...updates }));
    setHasUnsavedChanges(true);
  }, []);

  const updateSection = useCallback((sectionId: string, updates: Partial<DocumentSection>) => {
    setDocument((prev) => ({
      ...prev,
      content: {
        ...prev.content,
        sections: prev.content.sections.map((s) =>
          s.id === sectionId ? { ...s, ...updates } : s
        ),
      },
    }));
    setHasUnsavedChanges(true);
  }, []);

  const addSection = useCallback((type: SectionType = "custom") => {
    const newSection: DocumentSection = {
      id: nanoid(8),
      type,
      title: DEFAULT_TITLES[type],
      content: "",
      order: sections.length,
    };
    setDocument((prev) => ({
      ...prev,
      content: {
        ...prev.content,
        sections: [...prev.content.sections, newSection],
      },
    }));
    setHasUnsavedChanges(true);
  }, [sections.length]);

  const removeSection = useCallback((sectionId: string) => {
    setDocument((prev) => ({
      ...prev,
      content: {
        ...prev.content,
        sections: prev.content.sections
          .filter((s) => s.id !== sectionId)
          .map((s, i) => ({ ...s, order: i })),
      },
    }));
    setHasUnsavedChanges(true);
    setDeleteSection(null);
  }, []);

  const moveSection = useCallback((sectionId: string, direction: "up" | "down") => {
    setDocument((prev) => {
      const sectionIndex = prev.content.sections.findIndex((s) => s.id === sectionId);
      if (sectionIndex === -1) return prev;

      const newIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
      if (newIndex < 0 || newIndex >= prev.content.sections.length) return prev;

      const newSections = [...prev.content.sections];
      [newSections[sectionIndex], newSections[newIndex]] = [
        newSections[newIndex],
        newSections[sectionIndex],
      ];

      return {
        ...prev,
        content: {
          ...prev.content,
          sections: newSections.map((s, i) => ({ ...s, order: i })),
        },
      };
    });
    setHasUnsavedChanges(true);
  }, []);

  async function handleSave() {
    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: document.title,
            content: document.content,
            requiresContract: document.requiresContract,
          }),
        }
      );

      if (response.ok) {
        const updated = await response.json();
        setDocument(updated);
        setHasUnsavedChanges(false);
        toast.success("Document saved");
        onSave?.(updated);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to save document");
      }
    } catch {
      toast.error("Failed to save document");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSend() {
    // Save first if there are unsaved changes
    if (hasUnsavedChanges) {
      await handleSave();
    }

    setIsSending(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (response.ok) {
        const updated = await response.json();
        setDocument(updated);
        toast.success("Document sent");
        onSend?.(updated);

        // Copy public URL to clipboard
        if (updated.publicUrl) {
          const fullUrl = `${window.location.origin}${updated.publicUrl}`;
          await navigator.clipboard.writeText(fullUrl);
          toast.success("Public link copied to clipboard");
        }
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to send document");
      }
    } catch {
      toast.error("Failed to send document");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Input
            value={document.title}
            onChange={(e) => updateDocument({ title: e.target.value })}
            placeholder="Document title"
            disabled={isReadOnly}
            className="text-xl font-semibold border-none shadow-none px-0 focus-visible:ring-0"
          />
          <p className="text-sm text-muted-foreground mt-1">
            {document.type === "proposal" ? "Proposal" : "Contract"} &middot;{" "}
            <span
              className={cn(
                "capitalize",
                document.status === "accepted" && "text-green-600",
                document.status === "declined" && "text-red-600"
              )}
            >
              {document.status}
            </span>
          </p>
        </div>
        {!isReadOnly && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSave}
              disabled={isSaving || !hasUnsavedChanges}
              className="squircle"
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              <Save className="size-4" />
              Save
            </Button>
            <Button
              onClick={handleSend}
              disabled={isSending || sections.length === 0}
              className="squircle"
            >
              {isSending && <Loader2 className="size-4 animate-spin" />}
              <Send className="size-4" />
              Send
            </Button>
          </div>
        )}
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {sections.map((section, index) => (
          <Card key={section.id} className="squircle">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-1">
                  {!isReadOnly && (
                    <div className="flex flex-col gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={index === 0}
                        onClick={() => moveSection(section.id, "up")}
                      >
                        <ChevronUp className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={index === sections.length - 1}
                        onClick={() => moveSection(section.id, "down")}
                      >
                        <ChevronDown className="size-3" />
                      </Button>
                    </div>
                  )}
                  <div className="flex-1">
                    <Input
                      value={section.title}
                      onChange={(e) => updateSection(section.id, { title: e.target.value })}
                      disabled={isReadOnly}
                      className="font-medium border-none shadow-none px-0 focus-visible:ring-0"
                    />
                  </div>
                </div>
                {!isReadOnly && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8">
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem
                        onClick={() => setDeleteSection(section)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete Section
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <Textarea
                value={section.content}
                onChange={(e) => updateSection(section.id, { content: e.target.value })}
                placeholder="Enter content..."
                disabled={isReadOnly}
                rows={6}
                className="squircle resize-none"
              />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Add Section */}
      {!isReadOnly && (
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="squircle">
                <Plus className="size-4" />
                Add Section
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="squircle">
              {SECTION_TYPES.map((type) => (
                <DropdownMenuItem
                  key={type.value}
                  onClick={() => addSection(type.value)}
                >
                  {type.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Delete Section Dialog */}
      <AlertDialog open={!!deleteSection} onOpenChange={() => setDeleteSection(null)}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete section?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteSection?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteSection && removeSection(deleteSection.id)}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
