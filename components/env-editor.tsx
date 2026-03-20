"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Rocket, AlertTriangle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type EnvEditorProps = {
  projectId: string;
  projectName: string;
  orgId: string;
  initialVars: { key: string; isSecret: boolean | null }[];
  allProjectNames?: string[];
  orgVarKeys?: string[];
  environmentId?: string;
} | {
  /** Standalone mode — no project, just editing content with onChange callback */
  standalone: true;
  initialContent?: string;
  onChange: (content: string) => void;
  allProjectNames?: string[];
  orgVarKeys?: string[];
  /** Hide the cross-project variable reference section below the editor */
  showReferences?: boolean;
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

const PASSWORD_KEYS = ["password", "secret", "_key", "jwt"];
function isPasswordKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PASSWORD_KEYS.some((p) => lower.includes(p));
}

export function EnvEditor(props: EnvEditorProps) {
  const isStandalone = "standalone" in props && props.standalone;
  const projectId = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).projectId;
  const projectName = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).projectName;
  const orgId = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).orgId;
  const environmentId = isStandalone ? undefined : (props as Exclude<EnvEditorProps, { standalone: true }>).environmentId;
  const allProjectNames = props.allProjectNames ?? [];
  const orgVarKeys = props.orgVarKeys ?? [];

  const router = useRouter();
  const [content, setContentState] = useState(isStandalone ? (props.initialContent || "") : "");
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [loaded, setLoaded] = useState(isStandalone);
  const [modified, setModified] = useState(false);
  const [needsRedeploy, setNeedsRedeploy] = useState(false);
  const [passwordWarning, setPasswordWarning] = useState<string | null>(null);
  const [initialContent, setInitialContent] = useState(isStandalone ? (props.initialContent || "") : "");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Wrapper to also call onChange in standalone mode
  function setContent(value: string) {
    setContentState(value);
    if (isStandalone) {
      props.onChange(value);
    }
  }

  // Update content when initialContent prop changes (standalone mode — template switch)
  const prevInitialRef = useRef(isStandalone ? (props.initialContent || "") : "");
  useEffect(() => {
    if (!isStandalone) return;
    const newInitial = props.initialContent || "";
    if (newInitial !== prevInitialRef.current) {
      prevInitialRef.current = newInitial;
      setContentState(newInitial);
      setInitialContent(newInitial);
    }
  }, [isStandalone, isStandalone ? props.initialContent : null]);

  // Load current env vars as editable content (skip in standalone mode)
  useEffect(() => {
    if (isStandalone) return;
    async function load() {
      try {
        const params = new URLSearchParams();
        if (environmentId) params.set("environmentId", environmentId);
        const qs = params.toString();
        const res = await fetch(`/api/v1/organizations/${orgId}/projects/${projectId}/env-vars${qs ? `?${qs}` : ""}`);
        if (res.ok) {
          const data = await res.json();
          const vars = data.envVars || [];
          if (vars.length > 0) {
            const c = vars
              .map((v: { key: string; value: string }) => `${v.key}=${v.value}`)
              .join("\n");
            setContentState(c);
            setInitialContent(c);
          } else {
            setContentState("");
            setInitialContent("");
          }
        }
      } catch {
        // Start empty
      }
      setLoaded(true);
    }
    load();
  }, [orgId, projectId, environmentId, isStandalone]);

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
          // Org-level shared vars
          ...orgVarKeys.map((key) => ({
            label: `\${org.${key}}`,
            detail: "Org variable",
            insert: `\${org.${key}}`,
          })),
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

    // Check for password changes on persistent services
    const changedLines = value.split("\n").filter((line) => {
      if (!line.includes("=") || line.startsWith("#")) return false;
      const key = line.split("=")[0].trim();
      if (!isPasswordKey(key)) return false;
      // Check if this key's value changed from initial
      const initialLine = initialContent.split("\n").find((l) => l.startsWith(`${key}=`));
      return initialLine !== line;
    });
    setPasswordWarning(
      changedLines.length > 0
        ? `Changing ${changedLines.map((l) => l.split("=")[0]).join(", ")} won't update existing data in persistent volumes. You may need to manually update the service.`
        : null
    );
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

  async function doSave(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/env-vars`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, environmentId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
        return false;
      }

      const data = await res.json();
      toast.success(`${data.created} added, ${data.updated} updated`);
      setModified(false);
      setNeedsRedeploy(true);
      setInitialContent(content);
      setPasswordWarning(null);
      return true;
    } catch {
      toast.error("Failed to save");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    await doSave();
  }

  async function handleSaveAndDeploy() {
    const saved = await doSave();
    if (!saved) return;

    setDeploying(true);
    toast.info("Deploying with updated variables...");
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/deploy`,
        { method: "POST" }
      );
      // Don't wait for full deploy — it streams
      if (res.ok) {
        setNeedsRedeploy(false);
        router.refresh();
      }
    } catch {
      toast.error("Deploy failed");
    } finally {
      setDeploying(false);
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
        if (eqIdx === -1) return `<span class="text-zinc-300">${escapeHtml(line)}</span>`;

        const key = line.slice(0, eqIdx);
        const value = line.slice(eqIdx + 1);

        let highlightedValue = escapeHtml(value);

        // Highlight ${...} expressions
        highlightedValue = highlightedValue.replace(
          /\$\{([^}]+)\}/g,
          '<span class="text-cyan-400">${$1}</span>'
        );

        return `<span class="text-amber-400">${escapeHtml(key)}</span><span class="text-zinc-500">=</span><span class="text-zinc-200">${highlightedValue}</span>`;
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
      {/* Redeploy needed banner */}
      {!isStandalone && needsRedeploy && !modified && (
        <div className="flex items-center justify-between rounded-lg border border-status-warning/30 bg-status-warning-muted px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-status-warning shrink-0" />
            <p className="text-sm text-status-warning">
              Variables saved. Redeploy to apply changes.
            </p>
          </div>
          <Button
            size="sm"
            disabled={deploying}
            onClick={handleSaveAndDeploy}
          >
            {deploying ? (
              <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
            ) : (
              <><Rocket className="mr-1.5 size-4" />Redeploy</>
            )}
          </Button>
        </div>
      )}

      {/* Password change warning */}
      {!isStandalone && passwordWarning && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning-muted px-4 py-3">
          <AlertTriangle className="size-4 text-status-warning shrink-0 mt-0.5" />
          <p className="text-xs text-status-warning">{passwordWarning}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          KEY=value format. Use <code className="bg-muted px-1 py-0.5 rounded">{"${ref}"}</code> for variable references. Press Tab for autocomplete.
        </p>
        {!isStandalone && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={saving || deploying || !modified}
            >
              {saving ? (
                <><Loader2 className="mr-1.5 size-4 animate-spin" />Saving...</>
              ) : (
                "Save"
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleSaveAndDeploy}
              disabled={saving || deploying || !modified}
            >
              {deploying ? (
                <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
              ) : (
                <><Rocket className="mr-1.5 size-4" />Save & Deploy</>
              )}
            </Button>
          </div>
        )}
      </div>

      <div className="relative rounded-lg border bg-zinc-950 min-h-[400px]">
        {/* Syntax highlighted layer */}
        <div
          className="absolute inset-0 p-4 font-mono text-sm leading-6 whitespace-pre-wrap overflow-auto pointer-events-none"
          aria-hidden
        >
          {content ? (
            <div dangerouslySetInnerHTML={{ __html: highlightContent(content) }} />
          ) : (
            <span className="text-zinc-600">{"# Environment variables\nDATABASE_URL=postgres://localhost:5432/mydb\nREDIS_URL=redis://localhost:6379\n\n# Reference other projects\nDB_PASSWORD=${postgres.POSTGRES_PASSWORD}"}</span>
          )}
        </div>

        {/* Transparent textarea for input */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            setCursorPosition(e.currentTarget.selectionStart);
            setShowSuggestions(false);
          }}
          className="relative w-full p-4 font-mono text-sm leading-6 text-transparent caret-zinc-400 bg-transparent resize-none focus:outline-none min-h-[400px] selection:bg-zinc-700/50"
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

      {/* Variable references — hidden in standalone mode */}
      {!isStandalone && (() => {
        const keys = content
          .split("\n")
          .filter((l) => l.includes("=") && !l.startsWith("#"))
          .map((l) => l.split("=")[0].trim())
          .filter(Boolean);
        if (keys.length === 0) return null;
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Reference these variables from other projects:
            </p>
            <div className="grid gap-1">
              {keys.map((key) => {
                const ref = `\${${projectName}.${key}}`;
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 group"
                  >
                    <code className="text-xs font-mono text-muted-foreground">{ref}</code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(ref);
                        toast.success(`Copied ${ref}`);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-foreground transition-all"
                      title="Copy reference"
                    >
                      <Copy className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
