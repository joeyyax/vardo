"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  Copy,
  GripVertical,
  Loader2,
  Plus,
  Save,
  Trash2,
  Variable,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import type {
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  TemplateSectionMode,
  TemplateVariableType,
  DocumentType,
} from "@/lib/template-engine/types";
import { renderTemplate } from "@/lib/template-engine";
import { DocumentCanvas } from "@/components/documents/document-canvas";
import { SectionTiptapEditor } from "@/components/documents/section-tiptap-editor";

type TemplateData = {
  id: string;
  name: string;
  displayLabel: string | null;
  description: string | null;
  category: string | null;
  documentType: DocumentType;
  sections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig: TemplatePricingConfig | null;
  sortOrder: number;
  isStarter?: boolean;
};

type TemplateEditorContentProps = {
  orgId: string;
  templateId: string;
  canEdit: boolean;
};

const SECTION_MODES: { value: TemplateSectionMode; label: string; description: string }[] = [
  { value: "static", label: "Static", description: "Locked template content" },
  { value: "editable", label: "Editable", description: "Rich text editor for custom content" },
  { value: "form-driven", label: "Form-driven", description: "Rendered from form field values" },
];

const VARIABLE_TYPES: { value: TemplateVariableType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Multi-line Text" },
  { value: "richtext", label: "Rich Text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "select", label: "Dropdown" },
  { value: "boolean", label: "Toggle" },
  { value: "boilerplate", label: "Content Block" },
];

const DOCUMENT_TYPES: { value: DocumentType; label: string }[] = [
  { value: "proposal", label: "Proposal" },
  { value: "contract", label: "Contract" },
  { value: "change_order", label: "Change Order" },
  { value: "addendum", label: "Addendum" },
];

export function TemplateEditorContent({
  orgId,
  templateId,
  canEdit,
}: TemplateEditorContentProps) {
  const router = useRouter();
  const [template, setTemplate] = useState<TemplateData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Editable fields
  const [name, setName] = useState("");
  const [displayLabel, setDisplayLabel] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [documentType, setDocumentType] = useState<DocumentType>("proposal");
  const [sections, setSections] = useState<TemplateSection[]>([]);
  const [variables, setVariables] = useState<TemplateVariable[]>([]);

  // Starter templates are always read-only (must be duplicated to customize)
  const isStarter = template?.isStarter ?? false;
  const effectiveCanEdit = canEdit && !isStarter;

  // Sample context for preview rendering
  const sampleContext = useMemo(
    () => ({
      clientName: "Acme Corp",
      projectName: "Website Redesign",
      organizationName: "My Studio",
    }),
    []
  );

  // Build sample variable values from defaults and labels
  const sampleVariableValues = useMemo(() => {
    const values: Record<string, string> = {};
    for (const v of variables) {
      if (v.defaultValue !== undefined && v.defaultValue !== "") {
        values[v.key] = v.defaultValue;
      } else if (v.type === "boolean") {
        values[v.key] = "true";
      } else if (v.type === "currency") {
        values[v.key] = "5000";
      } else if (v.type === "number") {
        values[v.key] = "10";
      } else if (v.type === "date") {
        values[v.key] = new Date().toISOString().split("T")[0];
      } else if (v.type === "select" && v.options?.length) {
        values[v.key] = v.options[0].value;
      } else if (v.type === "boilerplate" && v.blocks?.length) {
        values[v.key] = v.blocks[0].value;
      } else if (v.type === "richtext") {
        values[v.key] = `<p>Sample ${v.label} content...</p>`;
      } else {
        values[v.key] = v.label || v.key;
      }
    }
    return values;
  }, [variables]);

  // Rendered preview content (always computed for live preview)
  const previewContent = useMemo(() => {
    if (sections.length === 0) return null;
    try {
      return renderTemplate(
        sections,
        variables,
        null,
        sampleVariableValues,
        sampleContext
      );
    } catch {
      return null;
    }
  }, [sections, variables, sampleVariableValues, sampleContext]);

  const fetchTemplate = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates/${templateId}`
      );
      if (response.ok) {
        const data: TemplateData = await response.json();
        setTemplate(data);
        setName(data.name);
        setDisplayLabel(data.displayLabel || "");
        setDescription(data.description || "");
        setCategory(data.category || "");
        setDocumentType(data.documentType);
        setSections(data.sections || []);
        setVariables(data.variableSchema || []);
      } else {
        toast.error("Template not found");
        router.push("/settings/templates");
      }
    } catch {
      toast.error("Failed to load template");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, templateId, router]);

  useEffect(() => {
    fetchTemplate();
  }, [fetchTemplate]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates/${templateId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            displayLabel: displayLabel.trim() || null,
            description: description.trim() || null,
            category: category.trim() || null,
            documentType,
            sections,
            variableSchema: variables,
          }),
        }
      );

      if (response.ok) {
        toast.success("Template saved");
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save template");
    } finally {
      setIsSaving(false);
    }
  }, [orgId, templateId, name, displayLabel, description, category, documentType, sections, variables]);

  // Duplicate starter template into a custom (editable) copy
  const handleDuplicate = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates/${templateId}/duplicate`,
        { method: "POST" }
      );
      if (response.ok) {
        const duplicate = await response.json();
        toast.success("Template duplicated — you can now edit it");
        router.push(`/settings/templates/${duplicate.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to duplicate");
      }
    } catch {
      toast.error("Failed to duplicate template");
    }
  }, [orgId, templateId, router]);

  // Detect variables from section bodies
  const detectVariables = useCallback(() => {
    const found = new Set<string>();
    for (const section of sections) {
      const matches = section.body.matchAll(/\{([^}]+)\}/g);
      for (const match of matches) {
        found.add(match[1]);
      }
      // Also check title
      const titleMatches = section.title.matchAll(/\{([^}]+)\}/g);
      for (const match of titleMatches) {
        found.add(match[1]);
      }
    }

    const existingKeys = new Set(variables.map((v) => v.key));
    const newVars: TemplateVariable[] = [];

    for (const key of found) {
      if (!existingKeys.has(key)) {
        newVars.push({
          key,
          label: key.replace(/([A-Z])/g, " $1").trim(),
          type: "text",
        });
      }
    }

    if (newVars.length === 0) {
      toast.info("No new variables found");
      return;
    }

    setVariables((prev) => [...prev, ...newVars]);
    toast.success(`Found ${newVars.length} new variable${newVars.length > 1 ? "s" : ""}`);
  }, [sections, variables]);

  // Section management
  const addSection = useCallback(() => {
    const newKey = `section_${sections.length + 1}`;
    setSections((prev) => [
      ...prev,
      {
        key: newKey,
        title: "New Section",
        body: "",
        mode: "static" as TemplateSectionMode,
        order: prev.length,
      },
    ]);
  }, [sections.length]);

  const updateSection = useCallback(
    (index: number, updates: Partial<TemplateSection>) => {
      setSections((prev) =>
        prev.map((s, i) => (i === index ? { ...s, ...updates } : s))
      );
    },
    []
  );

  const removeSection = useCallback((index: number) => {
    setSections((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Variable management
  const addVariable = useCallback(() => {
    setVariables((prev) => [
      ...prev,
      {
        key: `NewVariable${prev.length + 1}`,
        label: "New Variable",
        type: "text" as TemplateVariableType,
      },
    ]);
  }, []);

  const updateVariable = useCallback(
    (index: number, updates: Partial<TemplateVariable>) => {
      setVariables((prev) =>
        prev.map((v, i) => (i === index ? { ...v, ...updates } : v))
      );
    },
    []
  );

  const removeVariable = useCallback((index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!template) {
    return null;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] -mx-6 -mb-6">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
        <div className="flex items-center gap-4">
          <Link href="/settings/templates">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {isStarter ? "View Template" : "Edit Template"}
            </h1>
            <p className="text-sm text-muted-foreground">{template.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isStarter && (
            <Button variant="outline" onClick={handleDuplicate} className="squircle">
              <Copy className="size-4" />
              Duplicate to Customize
            </Button>
          )}
          {effectiveCanEdit && (
            <Button onClick={handleSave} disabled={isSaving} className="squircle">
              {isSaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {isSaving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </div>

      {/* Side-by-side: Editor (left) + Live Preview (right) */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Editor */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                disabled={!effectiveCanEdit}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Display Label
                <span className="text-muted-foreground ml-1">(optional)</span>
              </Label>
              <Input
                value={displayLabel}
                onChange={(e) => setDisplayLabel(e.target.value)}
                placeholder="e.g. Design Brief"
                disabled={!effectiveCanEdit}
              />
              <p className="text-[11px] text-muted-foreground">
                Overrides the type label in the UI.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Document Type</Label>
              <Select
                value={documentType}
                onValueChange={(v) => setDocumentType(v as DocumentType)}
                disabled={!effectiveCanEdit}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Category
                <span className="text-muted-foreground ml-1">(optional)</span>
              </Label>
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. hourly, retainer"
                disabled={!effectiveCanEdit}
              />
            </div>
            <div className="col-span-full space-y-1.5">
              <Label className="text-xs">
                Description
                <span className="text-muted-foreground ml-1">(optional)</span>
              </Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description for template picker..."
                rows={2}
                disabled={!effectiveCanEdit}
              />
            </div>
          </div>

          <Separator />

          {/* Sections */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Sections</h2>
              {effectiveCanEdit && (
                <Button variant="outline" size="sm" onClick={addSection}>
                  <Plus className="size-3.5" />
                  Add Section
                </Button>
              )}
            </div>

            {sections.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No sections defined. Add one to get started.
              </p>
            ) : (
              <div className="space-y-3">
                {sections.map((section, index) => (
                  <div
                    key={index}
                    className="rounded-lg border p-4 space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <GripVertical className="size-4 text-muted-foreground mt-2 shrink-0" />
                      <div className="flex-1 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="space-y-1">
                            <Label className="text-[11px]">Key</Label>
                            <Input
                              value={section.key}
                              onChange={(e) =>
                                updateSection(index, { key: e.target.value })
                              }
                              placeholder="section_key"
                              className="text-sm"
                              disabled={!effectiveCanEdit}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px]">Title</Label>
                            <Input
                              value={section.title}
                              onChange={(e) =>
                                updateSection(index, { title: e.target.value })
                              }
                              placeholder="Section Title"
                              className="text-sm"
                              disabled={!effectiveCanEdit}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px]">Mode</Label>
                            <Select
                              value={section.mode}
                              onValueChange={(v) =>
                                updateSection(index, {
                                  mode: v as TemplateSectionMode,
                                })
                              }
                              disabled={!effectiveCanEdit}
                            >
                              <SelectTrigger className="text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {SECTION_MODES.map((m) => (
                                  <SelectItem key={m.value} value={m.value}>
                                    {m.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {section.mode !== "editable" && (
                          <div className="space-y-1">
                            <Label className="text-[11px]">
                              Body
                              <span className="text-muted-foreground ml-1">
                                (markdown with &#123;Variables&#125;)
                              </span>
                            </Label>
                            <SectionTiptapEditor
                              markdownMode
                              content={section.body}
                              onChange={(body) =>
                                updateSection(index, { body })
                              }
                              placeholder="Section content with {VariableName} placeholders..."
                              readOnly={!effectiveCanEdit}
                              className="text-sm"
                            />
                          </div>
                        )}

                        {section.visibilityVar && (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">
                              Visibility: {section.visibilityVar}
                            </Badge>
                          </div>
                        )}
                      </div>

                      {effectiveCanEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeSection(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Variables */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Variables</h2>
              <div className="flex items-center gap-2">
                {effectiveCanEdit && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={detectVariables}
                    >
                      <Wand2 className="size-3.5" />
                      Detect Variables
                    </Button>
                    <Button variant="outline" size="sm" onClick={addVariable}>
                      <Plus className="size-3.5" />
                      Add Variable
                    </Button>
                  </>
                )}
              </div>
            </div>

            {variables.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No variables defined. Use &ldquo;Detect Variables&rdquo; to scan
                section bodies for &#123;VarName&#125; placeholders.
              </p>
            ) : (
              <div className="space-y-3">
                {variables.map((variable, index) => (
                  <div
                    key={index}
                    className="rounded-lg border p-4 space-y-3"
                  >
                    <div className="flex items-start gap-3">
                      <Variable className="size-4 text-muted-foreground mt-2 shrink-0" />
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <div className="space-y-1">
                          <Label className="text-[11px]">Key</Label>
                          <Input
                            value={variable.key}
                            onChange={(e) =>
                              updateVariable(index, { key: e.target.value })
                            }
                            placeholder="VariableName"
                            className="text-sm font-mono"
                            disabled={!effectiveCanEdit}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px]">Label</Label>
                          <Input
                            value={variable.label}
                            onChange={(e) =>
                              updateVariable(index, { label: e.target.value })
                            }
                            placeholder="Display label"
                            className="text-sm"
                            disabled={!effectiveCanEdit}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px]">Type</Label>
                          <Select
                            value={variable.type}
                            onValueChange={(v) =>
                              updateVariable(index, {
                                type: v as TemplateVariableType,
                              })
                            }
                            disabled={!effectiveCanEdit}
                          >
                            <SelectTrigger className="text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {VARIABLE_TYPES.map((t) => (
                                <SelectItem key={t.value} value={t.value}>
                                  {t.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px]">Section</Label>
                          <Select
                            value={variable.section || "__none__"}
                            onValueChange={(v) =>
                              updateVariable(index, {
                                section: v === "__none__" ? undefined : v,
                              })
                            }
                            disabled={!effectiveCanEdit}
                          >
                            <SelectTrigger className="text-sm">
                              <SelectValue placeholder="Global" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Global</SelectItem>
                              {sections.map((s) => (
                                <SelectItem key={s.key} value={s.key}>
                                  {s.title || s.key}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {effectiveCanEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeVariable(index)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>

                    {/* Extra config row */}
                    <div className="ml-7 grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[11px]">Default Value</Label>
                        <Input
                          value={variable.defaultValue || ""}
                          onChange={(e) =>
                            updateVariable(index, {
                              defaultValue: e.target.value || undefined,
                            })
                          }
                          placeholder="Default"
                          className="text-sm"
                          disabled={!effectiveCanEdit}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">Group</Label>
                        <Input
                          value={variable.group || ""}
                          onChange={(e) =>
                            updateVariable(index, {
                              group: e.target.value || undefined,
                            })
                          }
                          placeholder="e.g. Pricing"
                          className="text-sm"
                          disabled={!effectiveCanEdit}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">
                          Source
                          <span className="text-muted-foreground ml-1">(auto-fill)</span>
                        </Label>
                        <Select
                          value={variable.source || "__none__"}
                          onValueChange={(v) =>
                            updateVariable(index, {
                              source: v === "__none__" ? undefined : v,
                            })
                          }
                          disabled={!effectiveCanEdit}
                        >
                          <SelectTrigger className="text-sm">
                            <SelectValue placeholder="Manual" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Manual</SelectItem>
                            <SelectItem value="context.clientName">
                              Client Name
                            </SelectItem>
                            <SelectItem value="context.projectName">
                              Project Name
                            </SelectItem>
                            <SelectItem value="context.organizationName">
                              Organization Name
                            </SelectItem>
                            <SelectItem value="context.date">
                              Current Date
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {variable.type === "currency" && (
                        <div className="space-y-1">
                          <Label className="text-[11px]">Format</Label>
                          <Input
                            value={variable.format || ""}
                            onChange={(e) =>
                              updateVariable(index, {
                                format: e.target.value || undefined,
                              })
                            }
                            placeholder="$%s/hr"
                            className="text-sm font-mono"
                            disabled={!effectiveCanEdit}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Live Preview */}
        <div className="flex-1 overflow-y-auto border-l bg-muted/20">
          <div className="border-b px-4 py-2.5 bg-muted/30 sticky top-0 z-10">
            <p className="text-xs font-medium text-muted-foreground">
              Live Preview
            </p>
            <p className="text-[11px] text-muted-foreground">
              Sample data: Client = &quot;Acme Corp&quot;, Project = &quot;Website Redesign&quot;
            </p>
          </div>
          <div className="max-w-2xl mx-auto p-8">
            {previewContent && previewContent.sections.length > 0 ? (
              <DocumentCanvas
                sections={previewContent.sections}
                selectedSection={null}
                onSelectSection={() => {}}
                readOnly
                previewMode
              />
            ) : (
              <p className="text-sm text-muted-foreground text-center py-16">
                Add sections to see a live preview.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
