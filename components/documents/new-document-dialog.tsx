"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import {
  newDocumentSchema,
  type NewDocumentFormData,
} from "@/lib/schemas/document";
import { renderTemplate } from "@/lib/template-engine";
import type {
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  DocumentType,
} from "@/lib/template-engine/types";


type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type Template = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  documentType: DocumentType;
  sections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig: TemplatePricingConfig | null;
  isStarter?: boolean;
};

type NewDocumentDialogProps = {
  orgId: string;
  type: "proposal" | "contract" | "change_order" | "orientation";
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NewDocumentDialog({
  orgId,
  type,
  open,
  onOpenChange,
}: NewDocumentDialogProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(
    null
  );

  const form = useForm<NewDocumentFormData>({
    resolver: zodResolver(newDocumentSchema),
    defaultValues: {
      title: "",
      projectId: "",
    },
  });

  // Fetch projects and templates when dialog opens
  useEffect(() => {
    if (open) {
      if (projects.length === 0) fetchProjects();
      if (templates.length === 0) fetchTemplates();
      setStep(1);
      setSelectedTemplate(null);
    }
  }, [open]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      form.reset();
      setStep(1);
      setSelectedTemplate(null);
    }
  }, [open, form]);

  async function fetchProjects() {
    setProjectsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function fetchTemplates() {
    setTemplatesLoading(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates?documentType=${type}`
      );
      if (response.ok) {
        const data = await response.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error("Error fetching templates:", err);
    } finally {
      setTemplatesLoading(false);
    }
  }

  function handleSelectTemplate(template: Template | null) {
    setSelectedTemplate(template);
    if (template) {
      form.setValue("title", template.name);
    }
    setStep(2);
  }

  async function onSubmit(data: NewDocumentFormData) {
    setIsLoading(true);
    try {
      // Look up project + client for render context
      const project = projects.find((p) => p.id === data.projectId);
      const clientName = project?.client.name ?? "";
      const projectName = project?.name ?? "";

      let body: Record<string, unknown>;

      if (selectedTemplate) {
        // Render the template with context
        const rendered = renderTemplate(
          selectedTemplate.sections,
          selectedTemplate.variableSchema,
          selectedTemplate.pricingConfig,
          {},
          {
            clientName,
            projectName,
            organizationName: "",
          }
        );

        // Store template metadata in content so the builder can reconstruct
        // the editing experience even without a templateId FK.
        rendered.templateSections = selectedTemplate.sections;
        rendered.variableSchema = selectedTemplate.variableSchema;
        rendered.pricingConfig = selectedTemplate.pricingConfig ?? undefined;
        rendered.templateName = selectedTemplate.name;

        // Starter template IDs use "starter:" prefix — not valid UUIDs for the DB
        const isDbTemplate = !selectedTemplate.id.startsWith("starter:");

        body = {
          type,
          title: data.title.trim(),
          content: rendered,
          ...(isDbTemplate && { templateId: selectedTemplate.id }),
          variableValues: {},
        };
      } else {
        // Blank document
        body = {
          type,
          title: data.title.trim(),
        };
      }

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${data.projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (response.ok) {
        const document = await response.json();
        toast.success(
          `${type === "proposal" ? "Proposal" : "Contract"} created`
        );
        onOpenChange(false);
        router.push(`/projects/${data.projectId}/documents/${document.id}`);
      } else {
        const errorData = await response.json();
        toast.error(errorData.error || `Failed to create ${type}`);
      }
    } catch (err) {
      console.error(`Error creating ${type}:`, err);
      toast.error(`Failed to create ${type}`);
    } finally {
      setIsLoading(false);
    }
  }

  // Group projects by client for the dropdown
  const projectsByClient = projects.reduce(
    (acc, project) => {
      const clientName = project.client.name;
      if (!acc[clientName]) {
        acc[clientName] = [];
      }
      acc[clientName].push(project);
      return acc;
    },
    {} as Record<string, Project[]>
  );

  const typeLabel = type === "proposal" ? "Proposal" : "Contract";

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent size="lg">
        {step === 1 ? (
          <>
            <BottomSheetHeader>
              <BottomSheetTitle>New {typeLabel}</BottomSheetTitle>
              <BottomSheetDescription>
                Choose a template or start from scratch.
              </BottomSheetDescription>
            </BottomSheetHeader>

            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {templatesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 py-2">
                  {/* Blank document card */}
                  <button
                    type="button"
                    className="flex flex-col items-start gap-2 rounded-lg border-2 border-dashed p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                    onClick={() => handleSelectTemplate(null)}
                  >
                    <FileText className="size-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Blank Document</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Start with empty sections
                      </p>
                    </div>
                  </button>

                  {/* Template cards */}
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                      onClick={() => handleSelectTemplate(template)}
                    >
                      <FileText className="size-5 text-primary/70" />
                      <div className="min-w-0 w-full">
                        <p className="text-sm font-medium truncate">
                          {template.name}
                        </p>
                        {template.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {template.description}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-2">
                          {template.category && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0"
                            >
                              {template.category}
                            </Badge>
                          )}
                          {template.isStarter && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0"
                            >
                              Built-in
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <BottomSheetHeader>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => setStep(1)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <div>
                  <BottomSheetTitle>New {typeLabel}</BottomSheetTitle>
                  <BottomSheetDescription>
                    Configure your{" "}
                    {selectedTemplate
                      ? `"${selectedTemplate.name}" document`
                      : "blank document"}
                    .
                  </BottomSheetDescription>
                </div>
              </div>
            </BottomSheetHeader>

            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {selectedTemplate && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1.5">
                    <FileText className="size-3" />
                    {selectedTemplate.name}
                    <button
                      type="button"
                      className="ml-0.5 hover:text-foreground"
                      onClick={() => {
                        setSelectedTemplate(null);
                        form.setValue("title", "");
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </div>
              )}

              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="projectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Project</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger className="squircle">
                              <SelectValue placeholder="Select project" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="squircle">
                            {projectsLoading ? (
                              <div className="flex items-center justify-center py-2">
                                <Loader2 className="size-4 animate-spin" />
                              </div>
                            ) : projects.length === 0 ? (
                              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                                No projects found. Create a project first.
                              </div>
                            ) : (
                              Object.entries(projectsByClient).map(
                                ([clientName, clientProjects]) => (
                                  <div key={clientName}>
                                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                      {clientName}
                                    </div>
                                    {clientProjects.map((project) => (
                                      <SelectItem
                                        key={project.id}
                                        value={project.id}
                                      >
                                        {project.name}
                                      </SelectItem>
                                    ))}
                                  </div>
                                )
                              )
                            )}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder={`e.g., Website Redesign ${typeLabel}`}
                            className="squircle"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <BottomSheetFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                      className="squircle"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={isLoading || !form.watch("projectId")}
                      className="squircle"
                    >
                      {isLoading && <Loader2 className="size-4 animate-spin" />}
                      Create {typeLabel}
                    </Button>
                  </BottomSheetFooter>
                </form>
              </Form>
            </div>
          </>
        )}
      </BottomSheetContent>
    </BottomSheet>
  );
}
