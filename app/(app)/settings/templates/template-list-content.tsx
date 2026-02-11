"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
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
  ArrowLeft,
  Copy,
  FileText,
  Loader2,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import type { DocumentType } from "@/lib/template-engine/types";

type Template = {
  id: string;
  name: string;
  displayLabel: string | null;
  description: string | null;
  category: string | null;
  documentType: DocumentType;
  createdAt: string;
  isStarter?: boolean;
};

type TemplateListContentProps = {
  orgId: string;
  canEdit: boolean;
};

const TYPE_TABS: { value: DocumentType; label: string }[] = [
  { value: "proposal", label: "Proposals" },
  { value: "contract", label: "Contracts" },
  { value: "change_order", label: "Change Orders" },
  { value: "addendum", label: "Addenda" },
];

export function TemplateListContent({ orgId, canEdit }: TemplateListContentProps) {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<DocumentType>("proposal");
  const [deleteTemplate, setDeleteTemplate] = useState<Template | null>(null);
  const [isDuplicating, setIsDuplicating] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates`
      );
      if (response.ok) {
        const data = await response.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error("Error fetching templates:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  async function handleDelete() {
    if (!deleteTemplate) return;

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates/${deleteTemplate.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        fetchTemplates();
        toast.success("Template deleted");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to delete template");
      }
    } catch {
      toast.error("Failed to delete template");
    } finally {
      setDeleteTemplate(null);
    }
  }

  async function handleDuplicate(template: Template) {
    setIsDuplicating(template.id);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates/${template.id}/duplicate`,
        { method: "POST" }
      );

      if (response.ok) {
        const duplicate = await response.json();
        fetchTemplates();
        toast.success("Template duplicated");
        router.push(`/settings/templates/${duplicate.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to duplicate template");
      }
    } catch {
      toast.error("Failed to duplicate template");
    } finally {
      setIsDuplicating(null);
    }
  }

  async function handleCreateNew() {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentType: activeTab,
            name: `New ${TYPE_TABS.find(t => t.value === activeTab)?.label?.replace(/s$/, "") || "Template"}`,
            sections: [
              {
                key: "intro",
                title: "Introduction",
                body: "Dear {ClientName},\n\nThank you for the opportunity to work with you on {ProjectName}.",
                mode: "static",
                order: 0,
              },
              {
                key: "scope",
                title: "Scope of Work",
                body: "",
                mode: "editable",
                order: 1,
              },
              {
                key: "pricing",
                title: "Pricing",
                body: "Rate: {Rate}",
                mode: "form-driven",
                order: 2,
              },
            ],
            variableSchema: [
              { key: "ClientName", label: "Client Name", type: "text", source: "context.clientName" },
              { key: "ProjectName", label: "Project Name", type: "text", source: "context.projectName" },
              { key: "ScopeDescription", label: "Scope", type: "richtext", section: "scope" },
              { key: "Rate", label: "Rate", type: "currency", section: "pricing", group: "Pricing" },
            ],
          }),
        }
      );

      if (response.ok) {
        const template = await response.json();
        toast.success("Template created");
        router.push(`/settings/templates/${template.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to create template");
      }
    } catch {
      toast.error("Failed to create template");
    }
  }

  const filteredTemplates = templates.filter(
    (t) => t.documentType === activeTab
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/settings">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Document Templates
            </h1>
            <p className="text-sm text-muted-foreground">
              Manage templates for proposals, contracts, and more.
            </p>
          </div>
        </div>
        {canEdit && (
          <Button onClick={handleCreateNew} className="squircle">
            <Plus className="size-4" />
            New Template
          </Button>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DocumentType)}
      >
        <TabsList>
          {TYPE_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
              {templates.filter((t) => t.documentType === tab.value).length >
                0 && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 text-[10px] px-1.5 py-0"
                >
                  {
                    templates.filter((t) => t.documentType === tab.value)
                      .length
                  }
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {TYPE_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : filteredTemplates.length === 0 ? (
              <Card className="squircle">
                <CardContent className="py-12 text-center">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
                    <FileText className="size-5 text-muted-foreground" />
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    No {tab.label.toLowerCase()} templates yet.
                  </p>
                  {canEdit && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={handleCreateNew}
                      className="mt-2"
                    >
                      Create your first template
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredTemplates.map((template) => (
                  <Card
                    key={template.id}
                    className="squircle cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all"
                    onClick={() =>
                      router.push(`/settings/templates/${template.id}`)
                    }
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <CardTitle className="text-sm truncate">
                            {template.displayLabel || template.name}
                          </CardTitle>
                          {template.displayLabel && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {template.name}
                            </p>
                          )}
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            asChild
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                            >
                              <MoreVertical className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="squircle"
                          >
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDuplicate(template);
                              }}
                              disabled={isDuplicating === template.id}
                            >
                              <Copy className="size-4" />
                              {template.isStarter ? "Customize (Copy)" : "Duplicate"}
                            </DropdownMenuItem>
                            {!template.isStarter && (
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteTemplate(template);
                                }}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="size-4" />
                                Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-1.5 mb-2 empty:mb-0">
                        {template.isStarter && (
                          <Badge variant="outline" className="text-[10px]">
                            Built-in
                          </Badge>
                        )}
                        {template.category && (
                          <Badge variant="secondary" className="text-[10px]">
                            {template.category}
                          </Badge>
                        )}
                      </div>
                      {template.description && (
                        <CardDescription className="text-xs line-clamp-2">
                          {template.description}
                        </CardDescription>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Delete Template Dialog */}
      <AlertDialog
        open={!!deleteTemplate}
        onOpenChange={() => setDeleteTemplate(null)}
      >
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTemplate?.name}&rdquo;.
              Existing documents created from this template will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
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
