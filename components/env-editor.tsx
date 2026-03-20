"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type EnvEditorProps = {
  projectId: string;
  orgId: string;
  initialVars: { key: string; isSecret: boolean | null }[];
  allProjectNames?: string[];
};

type Suggestion = {
  label: string;
  detail: string;
  insert: string;
};

const BUILTIN_VARS: Suggestion[] = [
  { label: "${project.name}", detail: "Project slug", insert: "${project.name}" },
  { label: "${project.displayName}", detail: "Project display name", insert: "${project.displayName}" },
  { label: "${project.port}", detail: "Container port", insert: "${project.port}" },
  { label: "${project.id}", detail: "Project ID", insert: "${project.id}" },
  { label: "${org.name}", detail: "Organization name", insert: "${org.name}" },
  { label: "${org.id}", detail: "Organization ID", insert: "${org.id}" },
];

export function EnvEditor({ projectId, orgId, initialVars, allProjectNames = [] }: EnvEditorProps) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modified, setModified] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Load current env vars as editable content
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/env-vars`);
        if (res.ok) {
          const data = await res.json();
          const vars = data.envVars || [];
          // We only have keys, not values (secrets). Show keys with placeholder
          if (vars.length > 0) {
            // Fetch with values would need a dedicated endpoint
            // For now, show the keys as a starting template
            setContent(
              vars
                .map((v: { key: string }) => `${v.key}=`)
                .join("\n")
            );
          }
        }
      } catch {
        // Start empty
      }
      setLoaded(true);
    }
    load();
  }, [orgId, projectId]);

  // Build suggestions based on current context
  const buildSuggestions = useCallback(
    (text: string, cursor: number) => {
      // Find what's before the cursor on the current line
      const beforeCursor = text.slice(0, cursor);
      const currentLine = beforeCursor.split("\n").pop() || "";

      // Check if we're inside a ${...} expression
      const dollarIdx = currentLine.lastIndexOf("${");
      if (dollarIdx !== -1 && !currentLine.slice(dollarIdx).includes("}")) {
        const partial = currentLine.slice(dollarIdx + 2).toLowerCase();

        const allSuggestions: Suggestion[] = [
          ...BUILTIN_VARS,
          // Self-references from current content
          ...text
            .split("\n")
            .filter((line) => line.includes("=") && !line.startsWith("#"))
            .map((line) => {
              const key = line.split("=")[0].trim();
              return {
                label: `\${${key}}`,
                detail: "This project",
                insert: `\${${key}}`,
              };
            }),
          // Cross-project references
          ...allProjectNames.map((name) => ({
            label: `\${${name}.`,
            detail: "Cross-project ref",
            insert: `\${${name}.`,
          })),
        ];

        const filtered = allSuggestions.filter((s) =>
          s.label.toLowerCase().includes(partial)
        );

        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
        setSelectedSuggestion(0);
        return;
      }

      // Check if we're at the start of a line (suggest common env var names)
      if (currentLine === "" || /^[A-Z_]*$/.test(currentLine)) {
        const commonKeys = [
          "DATABASE_URL",
          "REDIS_URL",
          "SECRET_KEY",
          "API_KEY",
          "PORT",
          "NODE_ENV",
          "LOG_LEVEL",
          "SMTP_HOST",
          "SMTP_PORT",
          "S3_BUCKET",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
        ];

        const existing = new Set(
          text
            .split("\n")
            .filter((l) => l.includes("="))
            .map((l) => l.split("=")[0].trim())
        );

        const filtered = commonKeys
          .filter((k) => !existing.has(k))
          .filter((k) => k.toLowerCase().includes(currentLine.toLowerCase()))
          .map((k) => ({
            label: k,
            detail: "Common variable",
            insert: `${k}=`,
          }));

        if (filtered.length > 0 && currentLine.length > 0) {
          setSuggestions(filtered);
          setShowSuggestions(true);
          setSelectedSuggestion(0);
          return;
        }
      }

      setShowSuggestions(false);
    },
    [allProjectNames]
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);
    setModified(true);
    setCursorPosition(e.target.selectionStart);
    buildSuggestions(value, e.target.selectionStart);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showSuggestions) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (suggestions.length > 0) {
        e.preventDefault();
        applySuggestion(suggestions[selectedSuggestion]);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  function applySuggestion(suggestion: Suggestion) {
    if (!textareaRef.current) return;

    const textarea = textareaRef.current;
    const beforeCursor = content.slice(0, cursorPosition);
    const afterCursor = content.slice(cursorPosition);

    // Find the start of what we're replacing
    const currentLine = beforeCursor.split("\n").pop() || "";
    const dollarIdx = currentLine.lastIndexOf("${");

    let newContent: string;
    let newCursorPos: number;

    if (dollarIdx !== -1) {
      // Replace from ${ to cursor
      const lineStart = beforeCursor.length - currentLine.length;
      const replaceStart = lineStart + dollarIdx;
      newContent = content.slice(0, replaceStart) + suggestion.insert + afterCursor;
      newCursorPos = replaceStart + suggestion.insert.length;
    } else {
      // Replace current line content
      const lineStart = beforeCursor.length - currentLine.length;
      newContent = content.slice(0, lineStart) + suggestion.insert + afterCursor;
      newCursorPos = lineStart + suggestion.insert.length;
    }

    setContent(newContent);
    setModified(true);
    setShowSuggestions(false);

    // Restore cursor position
    requestAnimationFrame(() => {
      textarea.selectionStart = newCursorPos;
      textarea.selectionEnd = newCursorPos;
      textarea.focus();
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/env-vars`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
        return;
      }

      const data = await res.json();
      toast.success(`${data.created} added, ${data.updated} updated`);
      setModified(false);
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Syntax highlighting for the display overlay
  function highlightContent(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        if (line.startsWith("#")) {
          return `<span class="text-zinc-500">${escapeHtml(line)}</span>`;
        }

        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) return escapeHtml(line);

        const key = line.slice(0, eqIdx);
        const value = line.slice(eqIdx + 1);

        let highlightedValue = escapeHtml(value);

        // Highlight ${...} expressions
        highlightedValue = highlightedValue.replace(
          /\$\{([^}]+)\}/g,
          '<span class="text-cyan-400">${$1}</span>'
        );

        return `<span class="text-amber-400">${escapeHtml(key)}</span><span class="text-zinc-500">=</span>${highlightedValue}`;
      })
      .join("\n");
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          KEY=value format. Use <code className="bg-muted px-1 py-0.5 rounded">{"${ref}"}</code> for variable references. Press Tab for autocomplete.
        </p>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !modified}
        >
          {saving ? (
            <><Loader2 className="mr-1.5 size-4 animate-spin" />Saving...</>
          ) : (
            modified ? "Save Changes" : "Saved"
          )}
        </Button>
      </div>

      <div className="relative">
        {/* Syntax highlighted overlay */}
        <div
          className="absolute inset-0 rounded-lg border border-transparent bg-black/80 p-4 font-mono text-sm leading-6 whitespace-pre-wrap pointer-events-none overflow-hidden text-transparent"
          aria-hidden
        >
          <div dangerouslySetInnerHTML={{ __html: highlightContent(content) }} />
        </div>

        {/* Actual textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            setCursorPosition(e.currentTarget.selectionStart);
            setShowSuggestions(false);
          }}
          placeholder={"# Environment variables\nDATABASE_URL=postgres://localhost:5432/mydb\nREDIS_URL=redis://localhost:6379\n\n# Reference other projects\nDB_PASSWORD=${postgres.POSTGRES_PASSWORD}"}
          className="relative w-full rounded-lg border bg-black/80 p-4 font-mono text-sm leading-6 text-transparent caret-white resize-none focus:outline-none focus:ring-2 focus:ring-ring min-h-[400px]"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />

        {/* Autocomplete dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute z-50 mt-1 w-80 rounded-lg border bg-popover p-1 shadow-lg"
            style={{
              left: "1rem",
              bottom: "auto",
            }}
          >
            {suggestions.slice(0, 8).map((s, i) => (
              <button
                key={s.label}
                type="button"
                className={`flex items-center justify-between w-full rounded-md px-3 py-1.5 text-sm ${
                  i === selectedSuggestion
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(s);
                }}
                onMouseEnter={() => setSelectedSuggestion(i)}
              >
                <span className="font-mono text-xs">{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
