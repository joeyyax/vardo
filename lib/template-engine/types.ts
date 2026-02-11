/**
 * Types for the document template engine.
 *
 * Templates define the structure and variables for proposals, contracts,
 * change orders, and addenda. Documents are rendered snapshots.
 */

// Mirrors DOCUMENT_TYPES from schema.ts to avoid circular imports
export type DocumentType = "proposal" | "contract" | "change_order" | "orientation" | "addendum";

// ---------------------------------------------------------------------------
// Template section & variable definitions (stored in template.sections / .variableSchema)
// ---------------------------------------------------------------------------

export type TemplateSectionMode = "static" | "editable" | "form-driven";

export type TemplateSection = {
  key: string; // unique within template (e.g. "intro", "scope", "terms")
  title: string; // section heading (can contain {vars})
  body: string; // markdown content with {Variable} placeholders
  mode: TemplateSectionMode;
  order: number;
  /** Which boolean variable controls visibility (optional -- always visible if omitted) */
  visibilityVar?: string;
};

export type TemplateVariableType =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "currency"
  | "date"
  | "select"
  | "boolean"
  | "boilerplate";

export type TemplateVariable = {
  key: string; // matches {VarName} in section bodies
  label: string; // form field label
  description?: string; // help text
  type: TemplateVariableType;
  required?: boolean;
  defaultValue?: string;
  /** For "select" type */
  options?: Array<{ label: string; value: string }>;
  /** For "boilerplate" type -- pre-written content blocks */
  blocks?: Array<{ label: string; value: string; content: string }>;
  /** For "currency" type -- format string (e.g. "$%s/hr") */
  format?: string;
  /** Visual grouping in the form panel */
  group?: string;
  /** Auto-populated from context (e.g. "context.clientName") */
  source?: string;
  /** Which template section key this variable belongs to (for form-driven sections) */
  section?: string;
};

export type TemplatePricingConfig = {
  type: "fixed" | "hourly" | "retainer";
  fieldMap: {
    amount?: string; // variable key for total/amount
    rate?: string; // variable key for hourly rate
    estimatedHours?: string; // variable key for hours
  };
};

// ---------------------------------------------------------------------------
// Rendered document content (stored in documents.content -- frozen snapshot)
// ---------------------------------------------------------------------------

export type RenderedSection = {
  id: string; // nanoid
  key: string; // matches template section key
  title: string;
  content: string; // HTML for static/form-driven, Tiptap JSON string for editable
  mode: TemplateSectionMode;
  order: number;
  visible: boolean; // controlled by boolean variable toggles
};

export type DocumentContent = {
  sections: RenderedSection[];
  pricing?: {
    type: "fixed" | "hourly" | "retainer";
    amount?: number; // cents
    rate?: number; // cents
    estimatedHours?: number;
  };
  // Template metadata — stored at creation time so the builder can reconstruct
  // the editing experience even when templateId is null (e.g. starter templates).
  templateSections?: TemplateSection[];
  variableSchema?: TemplateVariable[];
  pricingConfig?: TemplatePricingConfig;
  templateName?: string;
  templateLabel?: string;
};

// ---------------------------------------------------------------------------
// Starter template shape (lives in code, same structure as DB rows minus org/DB fields)
// ---------------------------------------------------------------------------

export type StarterTemplate = {
  id: string; // stable identifier for matching (e.g. "hourly-proposal")
  documentType: DocumentType;
  name: string;
  displayLabel?: string;
  description: string;
  category: string;
  sections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig?: TemplatePricingConfig;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
// Render context -- project/client/org info injected at render time
// ---------------------------------------------------------------------------

export type RenderContext = {
  clientName: string;
  projectName: string;
  organizationName: string;
};
