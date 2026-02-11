/**
 * Template rendering engine.
 *
 * Converts a template (sections + variable schema) into frozen DocumentContent
 * by substituting variables, rendering markdown, and building pricing.
 */

import { nanoid } from "nanoid";
import type {
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  DocumentContent,
  RenderedSection,
  RenderContext,
} from "./types";

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Replace all {Variable} placeholders in a string with values from the map.
 */
export function substituteVariables(
  text: string,
  variables: Record<string, string>
): string {
  return text.replace(/\{([^}]+)\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}

/**
 * Build a variable map by merging context-sourced values with user input,
 * applying formatting (currency, dates), and defaults.
 */
export function buildVariableMap(
  schema: TemplateVariable[],
  userValues: Record<string, string>,
  context: RenderContext
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Context sources
  const contextMap: Record<string, string> = {
    "context.clientName": context.clientName,
    "context.projectName": context.projectName,
    "context.organizationName": context.organizationName,
    "context.date": new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  };

  for (const variable of schema) {
    // Auto-populate from context
    if (variable.source && contextMap[variable.source]) {
      vars[variable.key] = contextMap[variable.source];
      continue;
    }

    // User-provided value
    const userValue = userValues[variable.key];

    if (userValue !== undefined && userValue !== "") {
      // Apply formatting
      if (variable.type === "currency" && variable.format) {
        vars[variable.key] = variable.format.replace("%s", userValue);
      } else if (variable.type === "boilerplate") {
        // Look up the content block by value
        const block = variable.blocks?.find((b) => b.value === userValue);
        vars[variable.key] = block?.content ?? userValue;
      } else {
        vars[variable.key] = userValue;
      }
    } else if (variable.defaultValue !== undefined) {
      vars[variable.key] = variable.defaultValue;
    } else {
      // Show a readable placeholder so the preview never shows raw {VariableName}
      vars[variable.key] = `[${variable.label}]`;
    }
  }

  return vars;
}

// ---------------------------------------------------------------------------
// Lightweight markdown → HTML
// ---------------------------------------------------------------------------

/**
 * Convert simple markdown to HTML. Handles the subset used in document templates:
 * headings, bold, italic, lists, links, horizontal rules, tables, blockquotes.
 */
export function markdownToHtml(markdown: string): string {
  let html = markdown;

  // Escape HTML entities in the raw text (before we add our own tags)
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headings (### h3, ## h2 — we skip h1 since section titles serve that role)
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr />");

  // Tables (simple: | header | header | ... then | --- | --- | ... then rows)
  html = html.replace(
    /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_match, headerRow: string, _separator, bodyRows: string) => {
      const headers = headerRow
        .split("|")
        .filter((c: string) => c.trim())
        .map((c: string) => `<th>${c.trim()}</th>`)
        .join("");
      const rows = bodyRows
        .trim()
        .split("\n")
        .map((row: string) => {
          const cells = row
            .split("|")
            .filter((c: string) => c.trim())
            .map((c: string) => `<td>${c.trim()}</td>`)
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }
  );

  // Unordered lists (- item)
  html = html.replace(
    /^((?:- .+\n?)+)/gm,
    (block) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => `<li>${line.replace(/^- /, "")}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }
  );

  // Ordered lists (1. item)
  html = html.replace(
    /^((?:\d+\. .+\n?)+)/gm,
    (block) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => `<li>${line.replace(/^\d+\. /, "")}</li>`)
        .join("");
      return `<ol>${items}</ol>`;
    }
  );

  // Blockquotes
  html = html.replace(
    /^((?:> .+\n?)+)/gm,
    (block) => {
      const content = block
        .trim()
        .split("\n")
        .map((line) => line.replace(/^> /, ""))
        .join("\n");
      return `<blockquote>${content}</blockquote>`;
    }
  );

  // Paragraphs — wrap remaining loose text in <p> tags
  // Split by double newline, wrap non-tag lines
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Don't wrap if it already starts with a block-level tag
      if (/^<(h[2-3]|ul|ol|table|blockquote|hr|p)/.test(trimmed)) {
        return trimmed;
      }
      // Replace single newlines with <br> within paragraphs
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");

  return html;
}

// ---------------------------------------------------------------------------
// Pricing builder
// ---------------------------------------------------------------------------

/**
 * Build structured pricing from pricing config + variable values.
 * Converts dollar strings to cents.
 */
export function buildPricingFromConfig(
  config: TemplatePricingConfig | undefined | null,
  vars: Record<string, string>
): DocumentContent["pricing"] {
  if (!config) return undefined;

  const parseCents = (key: string | undefined): number | undefined => {
    if (!key) return undefined;
    const raw = vars[key];
    if (!raw) return undefined;
    // Strip currency symbols and formatting, parse as float, convert to cents
    const num = parseFloat(raw.replace(/[^0-9.-]/g, ""));
    return isNaN(num) ? undefined : Math.round(num * 100);
  };

  const parseNum = (key: string | undefined): number | undefined => {
    if (!key) return undefined;
    const raw = vars[key];
    if (!raw) return undefined;
    const num = parseFloat(raw.replace(/[^0-9.-]/g, ""));
    return isNaN(num) ? undefined : num;
  };

  return {
    type: config.type,
    amount: parseCents(config.fieldMap.amount),
    rate: parseCents(config.fieldMap.rate),
    estimatedHours: parseNum(config.fieldMap.estimatedHours),
  };
}

// ---------------------------------------------------------------------------
// Full template renderer
// ---------------------------------------------------------------------------

/**
 * Render a template into frozen DocumentContent.
 *
 * For each template section:
 * - Substitute variables in title and body
 * - Set visibility based on boolean variable linked via visibilityVar
 * - For editable sections: use the richtext variable's value as content
 * - For static/form-driven sections: render markdown → HTML
 */
export function renderTemplate(
  sections: TemplateSection[],
  variableSchema: TemplateVariable[],
  pricingConfig: TemplatePricingConfig | undefined | null,
  variableValues: Record<string, string>,
  context: RenderContext
): DocumentContent {
  const vars = buildVariableMap(variableSchema, variableValues, context);

  const renderedSections: RenderedSection[] = sections
    .sort((a, b) => a.order - b.order)
    .map((section) => {
      // Determine visibility
      let visible = true;
      if (section.visibilityVar) {
        const toggleValue = variableValues[section.visibilityVar];
        visible = toggleValue === "true" || toggleValue === "1";
      }

      // Render content based on mode
      let content: string;
      if (section.mode === "editable") {
        // For editable sections, find the richtext variable for this section
        const richtextVar = variableSchema.find(
          (v) => v.type === "richtext" && v.section === section.key
        );
        content = richtextVar
          ? (variableValues[richtextVar.key] ?? "")
          : substituteVariables(section.body, vars);
      } else {
        // Static and form-driven: substitute variables then convert markdown
        const substituted = substituteVariables(section.body, vars);
        content = markdownToHtml(substituted);
      }

      return {
        id: nanoid(8),
        key: section.key,
        title: substituteVariables(section.title, vars),
        content,
        mode: section.mode,
        order: section.order,
        visible,
      };
    });

  return {
    sections: renderedSections,
    pricing: buildPricingFromConfig(pricingConfig, vars),
  };
}
