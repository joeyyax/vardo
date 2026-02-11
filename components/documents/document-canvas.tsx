"use client";

import { cn } from "@/lib/utils";
import { Lock, Pencil, FormInput, Eye } from "lucide-react";
import type { RenderedSection } from "@/lib/template-engine/types";
import { generateHTML } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";

// ---------------------------------------------------------------------------
// Document Canvas — shared between DocumentBuilder and template preview
// ---------------------------------------------------------------------------

export function DocumentCanvas({
  sections,
  selectedSection,
  onSelectSection,
  readOnly,
  previewMode,
}: {
  sections: RenderedSection[];
  selectedSection: string | null;
  onSelectSection: (key: string | null) => void;
  readOnly?: boolean;
  /** Strip section chrome (mode icons, borders, click handlers) for clean preview */
  previewMode?: boolean;
}) {
  const visibleSections = sections.filter((s) => s.visible);

  if (visibleSections.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Eye className="size-8 mx-auto mb-3 opacity-50" />
        <p className="text-sm">No visible sections.</p>
        <p className="text-xs mt-1">
          Toggle sections on in the settings panel.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {visibleSections.map((section) => (
        <div key={section.key} id={`section-${section.key}`}>
          <SectionBlock
            section={section}
            isSelected={selectedSection === section.key}
            onClick={
              readOnly || previewMode
                ? undefined
                : () => onSelectSection(section.key)
            }
            readOnly={readOnly}
            previewMode={previewMode}
          />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section Block
// ---------------------------------------------------------------------------

export function SectionBlock({
  section,
  isSelected,
  onClick,
  readOnly,
  previewMode,
}: {
  section: RenderedSection;
  isSelected: boolean;
  onClick?: () => void;
  readOnly?: boolean;
  previewMode?: boolean;
}) {
  if (previewMode) {
    return (
      <div>
        <h3 className="font-medium text-sm mb-2">{section.title}</h3>
        {section.mode === "editable" ? (
          <EditableSectionContent content={section.content} />
        ) : (
          <StaticSectionContent html={section.content} />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border transition-all",
        !readOnly && "cursor-pointer hover:border-primary/30 hover:shadow-sm",
        isSelected && "border-primary ring-1 ring-primary/20",
        readOnly && "border-transparent"
      )}
      onClick={onClick}
    >
      {/* Section header */}
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2",
          !readOnly && "border-b bg-muted/30"
        )}
      >
        {!readOnly && <SectionModeIcon mode={section.mode} />}
        <h3 className="font-medium text-sm">{section.title}</h3>
      </div>

      {/* Section content */}
      <div className="px-4 py-3">
        {section.mode === "editable" ? (
          <EditableSectionContent content={section.content} />
        ) : (
          <StaticSectionContent html={section.content} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section Mode Icon
// ---------------------------------------------------------------------------

export function SectionModeIcon({ mode }: { mode: string }) {
  switch (mode) {
    case "static":
      return <Lock className="size-3.5 text-muted-foreground" />;
    case "editable":
      return <Pencil className="size-3.5 text-blue-500" />;
    case "form-driven":
      return <FormInput className="size-3.5 text-green-500" />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Section Content renderers
// Note: HTML content comes from the template engine's markdownToHtml which
// processes trusted template content, not user-submitted HTML.
// ---------------------------------------------------------------------------

export function StaticSectionContent({ html }: { html: string }) {
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      // Content is generated from trusted template markdown via markdownToHtml
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function EditableSectionContent({ content }: { content: string }) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Click to add content...
      </p>
    );
  }

  const html = tiptapContentToHtml(content);

  // Content is from TipTap editor output (getHTML or generateHTML from stored JSON),
  // not user-submitted HTML — same trust model as StaticSectionContent above.
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Convert editable section content (TipTap JSON string or HTML) to HTML.
 * Handles backwards compat: old docs stored as TipTap JSON, new docs as HTML.
 */
function tiptapContentToHtml(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed?.type === "doc") {
      return generateHTML(parsed, [
        StarterKit.configure({ heading: { levels: [2, 3] } }),
        Link,
      ]);
    }
  } catch {
    // Not JSON — treat as HTML
  }
  return content;
}
