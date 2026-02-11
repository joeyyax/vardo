"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  FileText,
  Loader2,
  Sparkles,
  Library,
  FilePlus2,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  StarterTemplate,
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  DocumentType,
} from "@/lib/template-engine/types";
import {
  getStarterTemplatesByType,
} from "@/lib/template-engine/starter-templates";
import { renderTemplate } from "@/lib/template-engine";
import type { RenderContext } from "@/lib/template-engine/types";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgTemplate = {
  id: string;
  name: string;
  displayLabel: string | null;
  description: string | null;
  category: string | null;
  documentType: string;
  sections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig: TemplatePricingConfig | null;
};

type BillingDefaults = {
  resolvedRate: number | null; // cents/hr — project → client → org
  retainerAmount: number | null; // cents/mo — from client
  includedHours: number | null; // from client.includedMinutes / 60
  overageRate: number | null; // cents/hr — from client
  billingFrequency: string | null; // from client
};

type TemplateWizardProps = {
  orgId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  organizationName: string;
  documentType: DocumentType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the matching template card shows a "Recommended" badge */
  suggestedTemplateId?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TemplateWizard({
  orgId,
  projectId,
  projectName,
  clientName,
  organizationName,
  documentType,
  open,
  onOpenChange,
  suggestedTemplateId,
}: TemplateWizardProps) {
  const router = useRouter();
  const [orgTemplates, setOrgTemplates] = useState<OrgTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>("starters");
  // Cache billing defaults so the fetch is shared across template selections
  const billingPromiseRef = useRef<Promise<BillingDefaults | null> | null>(null);

  const starterTemplates = getStarterTemplatesByType(documentType);

  const context: RenderContext = {
    clientName,
    projectName,
    organizationName,
  };

  // Fetch org custom templates
  const fetchOrgTemplates = useCallback(async () => {
    setIsLoadingTemplates(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/templates?documentType=${documentType}`
      );
      if (response.ok) {
        const data = await response.json();
        setOrgTemplates(data);
      }
    } catch (err) {
      console.error("Error fetching org templates:", err);
    } finally {
      setIsLoadingTemplates(false);
    }
  }, [orgId, documentType]);

  /**
   * Resolve billing defaults from the hierarchy (project → client → org).
   * Returns a cached promise so multiple calls share the same fetch.
   */
  function getBillingDefaults(): Promise<BillingDefaults | null> {
    if (billingPromiseRef.current) return billingPromiseRef.current;

    billingPromiseRef.current = (async () => {
      try {
        const [projectRes, orgRes] = await Promise.all([
          fetch(`/api/v1/organizations/${orgId}/projects/${projectId}`),
          fetch(`/api/v1/organizations/${orgId}`),
        ]);
        if (!projectRes.ok || !orgRes.ok) return null;

        const projectData = await projectRes.json();
        const orgData = await orgRes.json();
        const orgDefaultRate: number | null = orgData.organization?.defaultRate ?? null;

        // Fetch client with billing fields
        const clientId = projectData.clientId;
        if (!clientId) return null;

        const clientRes = await fetch(`/api/v1/organizations/${orgId}/clients/${clientId}`);
        if (!clientRes.ok) return null;
        const clientData = await clientRes.json();

        // Resolve rate: project → client → org
        const resolvedRate =
          projectData.rateOverride ?? clientData.rateOverride ?? orgDefaultRate;

        return {
          resolvedRate,
          retainerAmount: clientData.retainerAmount ?? null,
          includedHours: clientData.includedMinutes
            ? Math.round(clientData.includedMinutes / 60)
            : null,
          overageRate: clientData.overageRate ?? null,
          billingFrequency: clientData.billingFrequency ?? null,
        };
      } catch (err) {
        console.error("Error fetching billing defaults:", err);
        return null;
      }
    })();

    return billingPromiseRef.current;
  }

  useEffect(() => {
    if (open) {
      fetchOrgTemplates();
      billingPromiseRef.current = null; // clear cache on reopen
      setSearchQuery("");
    }
  }, [open, fetchOrgTemplates]);

  // Switch to "Your Templates" if org has templates
  useEffect(() => {
    if (orgTemplates.length > 0 && activeTab === "starters") {
      setActiveTab("yours");
    }
  }, [orgTemplates.length]);

  /**
   * Inject resolved billing defaults into variable values using the
   * template's pricingConfig.fieldMap to map the right value to the right key.
   */
  function applyBillingDefaults(
    values: Record<string, string>,
    schema: TemplateVariable[],
    pricingConfig: TemplatePricingConfig | null | undefined,
    billing: BillingDefaults
  ) {
    const centsToStr = (cents: number) => String(cents / 100);

    if (pricingConfig?.fieldMap) {
      const { fieldMap } = pricingConfig;

      // Rate field — for hourly: resolved rate; for retainer: overage rate (or resolved as fallback)
      if (fieldMap.rate && !values[fieldMap.rate]) {
        const rate =
          pricingConfig.type === "retainer"
            ? (billing.overageRate ?? billing.resolvedRate)
            : billing.resolvedRate;
        if (rate) values[fieldMap.rate] = centsToStr(rate);
      }

      // Amount field — only for retainer (retainer amount from client)
      if (fieldMap.amount && !values[fieldMap.amount] && pricingConfig.type === "retainer") {
        if (billing.retainerAmount) {
          values[fieldMap.amount] = centsToStr(billing.retainerAmount);
        }
      }

      // Estimated hours — from client included hours
      if (fieldMap.estimatedHours && !values[fieldMap.estimatedHours]) {
        if (billing.includedHours) {
          values[fieldMap.estimatedHours] = String(billing.includedHours);
        }
      }
    }

    // BillingCadence select — map from client billing frequency
    if (billing.billingFrequency) {
      const cadenceVar = schema.find(
        (v) => v.key === "BillingCadence" && v.type === "select"
      );
      if (cadenceVar && !values[cadenceVar.key]) {
        const freqMap: Record<string, string> = {
          weekly: "Weekly",
          biweekly: "Bi-weekly",
          monthly: "Monthly",
          quarterly: "Quarterly",
        };
        const mapped = freqMap[billing.billingFrequency];
        if (mapped) values[cadenceVar.key] = mapped;
      }
    }
  }

  async function handleSelectStarter(template: StarterTemplate) {
    setIsCreating(true);
    try {
      // Render the template with default values and context
      const defaultValues: Record<string, string> = {};
      for (const v of template.variableSchema) {
        if (v.defaultValue !== undefined) {
          defaultValues[v.key] = v.defaultValue;
        }
      }

      // Await billing defaults so they're guaranteed to be available
      const billing = await getBillingDefaults();
      if (billing) {
        applyBillingDefaults(defaultValues, template.variableSchema, template.pricingConfig, billing);
      }

      const content = renderTemplate(
        template.sections,
        template.variableSchema,
        template.pricingConfig || null,
        defaultValues,
        context
      );

      // Embed template metadata so the builder can reconstruct form fields
      content.templateSections = template.sections;
      content.variableSchema = template.variableSchema;
      content.pricingConfig = template.pricingConfig ?? undefined;
      content.templateName = template.name;

      const typeLabels: Record<string, string> = {
        proposal: "Proposal",
        contract: "Contract",
        change_order: "Change Order",
        addendum: "Addendum",
      };

      const title = `${typeLabels[documentType] || documentType} — ${projectName}`;

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: documentType,
            title,
            content,
            variableValues: defaultValues,
          }),
        }
      );

      if (response.ok) {
        const document = await response.json();
        onOpenChange(false);
        toast.success("Document created");
        router.push(`/projects/${projectId}/documents/${document.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to create document");
      }
    } catch {
      toast.error("Failed to create document");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSelectOrgTemplate(template: OrgTemplate) {
    setIsCreating(true);
    try {
      const defaultValues: Record<string, string> = {};
      for (const v of template.variableSchema) {
        if (v.defaultValue !== undefined) {
          defaultValues[v.key] = v.defaultValue;
        }
      }

      const billing = await getBillingDefaults();
      if (billing) {
        applyBillingDefaults(defaultValues, template.variableSchema, template.pricingConfig, billing);
      }

      const content = renderTemplate(
        template.sections,
        template.variableSchema,
        template.pricingConfig,
        defaultValues,
        context
      );

      // Embed template metadata so the builder can reconstruct form fields
      content.templateSections = template.sections;
      content.variableSchema = template.variableSchema;
      content.pricingConfig = template.pricingConfig ?? undefined;
      content.templateName = template.displayLabel || template.name;

      const title = `${template.displayLabel || template.name} — ${projectName}`;

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: documentType,
            title,
            content,
            // Starter template IDs use "starter:" prefix — not valid UUIDs for the DB
            ...(!template.id.startsWith("starter:") && { templateId: template.id }),
            variableValues: defaultValues,
          }),
        }
      );

      if (response.ok) {
        const document = await response.json();
        onOpenChange(false);
        toast.success("Document created");
        router.push(`/projects/${projectId}/documents/${document.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to create document");
      }
    } catch {
      toast.error("Failed to create document");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCreateBlank() {
    setIsCreating(true);
    try {
      const typeLabels: Record<string, string> = {
        proposal: "Proposal",
        contract: "Contract",
        change_order: "Change Order",
        addendum: "Addendum",
      };

      const title = `${typeLabels[documentType] || documentType} — ${projectName}`;

      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: documentType,
            title,
          }),
        }
      );

      if (response.ok) {
        const document = await response.json();
        onOpenChange(false);
        toast.success("Document created");
        router.push(`/projects/${projectId}/documents/${document.id}`);
      } else {
        const error = await response.json();
        toast.error(error.error || "Failed to create document");
      }
    } catch {
      toast.error("Failed to create document");
    } finally {
      setIsCreating(false);
    }
  }

  const filteredStarters = searchQuery
    ? starterTemplates.filter(
        (t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.category.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : starterTemplates;

  const filteredOrgTemplates = searchQuery
    ? orgTemplates.filter(
        (t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.description || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.category || "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    : orgTemplates;

  const typeLabel =
    documentType === "proposal"
      ? "Proposal"
      : documentType === "contract"
        ? "Contract"
        : documentType === "change_order"
          ? "Change Order"
          : documentType === "addendum"
            ? "Addendum"
            : "Document";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full" className="squircle p-0 gap-0 overflow-hidden flex flex-col" showCloseButton={false}>
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>New {typeLabel}</DialogTitle>
              <DialogDescription>
                Choose a template to get started, or create a blank document.
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              <ArrowLeft className="size-4 mr-1" />
              Cancel
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6">
          {/* Search */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search templates..."
              className="pl-9"
            />
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4">
              {orgTemplates.length > 0 && (
                <TabsTrigger value="yours" className="gap-1.5">
                  <Library className="size-3.5" />
                  Your Templates
                </TabsTrigger>
              )}
              <TabsTrigger value="starters" className="gap-1.5">
                <Sparkles className="size-3.5" />
                Starter Templates
              </TabsTrigger>
              <TabsTrigger value="blank" className="gap-1.5">
                <FilePlus2 className="size-3.5" />
                Blank
              </TabsTrigger>
            </TabsList>

            {/* Your Templates */}
            {orgTemplates.length > 0 && (
              <TabsContent value="yours">
                {isLoadingTemplates ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredOrgTemplates.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <p className="text-sm">No matching templates found.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredOrgTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        name={template.displayLabel || template.name}
                        description={template.description || ""}
                        category={template.category || ""}
                        onClick={() => handleSelectOrgTemplate(template)}
                        disabled={isCreating}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            )}

            {/* Starter Templates */}
            <TabsContent value="starters">
              {filteredStarters.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p className="text-sm">No matching starter templates found.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredStarters.map((template) => (
                    <TemplateCard
                      key={template.id}
                      name={template.displayLabel || template.name}
                      description={template.description}
                      category={template.category}
                      onClick={() => handleSelectStarter(template)}
                      disabled={isCreating}
                      recommended={suggestedTemplateId === template.id}
                    />
                  ))}
                </div>
              )}
            </TabsContent>

            {/* Blank */}
            <TabsContent value="blank">
              <div className="max-w-md mx-auto text-center py-12">
                <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted mb-4">
                  <FilePlus2 className="size-7 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium mb-1">Blank {typeLabel}</h3>
                <p className="text-sm text-muted-foreground mb-6">
                  Start from scratch with basic editable sections.
                </p>
                <Button
                  onClick={handleCreateBlank}
                  disabled={isCreating}
                  className="squircle"
                >
                  {isCreating && <Loader2 className="size-4 animate-spin mr-1.5" />}
                  Create Blank {typeLabel}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {isCreating && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-50">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Creating document...
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Template Card
// ---------------------------------------------------------------------------

function TemplateCard({
  name,
  description,
  category,
  onClick,
  disabled,
  recommended,
}: {
  name: string;
  description: string;
  category: string;
  onClick: () => void;
  disabled?: boolean;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "text-left rounded-lg border p-4 transition-all hover:border-primary/30 hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "opacity-50 cursor-not-allowed",
        recommended && "border-primary/50 shadow-sm"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm truncate">{name}</p>
            {recommended && (
              <Badge variant="default" className="text-[10px] shrink-0">
                Recommended
              </Badge>
            )}
          </div>
          {category && (
            <Badge variant="secondary" className="text-[10px] mt-1">
              {category}
            </Badge>
          )}
          {description && (
            <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">
              {description}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
