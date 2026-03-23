"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/lib/messenger";

type Props = {
  orgId: string;
};

type Suggestion = {
  label: string;
  detail: string;
  insert: string;
};

export function OrgEnvVarsEditor({ orgId }: Props) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modified, setModified] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/v1/organizations/${orgId}/env-vars`);
        if (res.ok) {
          const data = await res.json();
          const vars = data.envVars || [];
          if (vars.length > 0) {
            setContent(
              vars
                .map((v: { key: string; value: string; isSecret: boolean | null }) =>
                  v.isSecret ? `${v.key}=` : `${v.key}=${v.value}`
                )
                .join("\n")
            );
          }
        }
      } catch { /* start empty */ }
      setLoaded(true);
    }
    load();
  }, [orgId]);

  const buildSuggestions = useCallback((text: string, cursor: number) => {
    const beforeCursor = text.slice(0, cursor);
    const currentLine = beforeCursor.split("\n").pop() || "";

    if (currentLine === "" || /^[A-Z_]*$/.test(currentLine)) {
      const commonKeys = [
        "API_KEY", "SECRET_KEY", "DATABASE_URL", "REDIS_URL",
        "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD",
        "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY",
        "SENTRY_DSN", "LOG_LEVEL", "NODE_ENV",
      ];
      const existing = new Set(
        text.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=")[0].trim())
      );
      const filtered = commonKeys
        .filter((k) => !existing.has(k))
        .filter((k) => k.toLowerCase().includes(currentLine.toLowerCase()))
        .map((k) => ({ label: k, detail: "Common variable", insert: `${k}=` }));

      if (filtered.length > 0 && currentLine.length > 0) {
        setSuggestions(filtered);
        setShowSuggestions(true);
        setSelectedSuggestion(0);
        return;
      }
    }
    setShowSuggestions(false);
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value);
    setModified(true);
    setCursorPosition(e.target.selectionStart);
    buildSuggestions(e.target.value, e.target.selectionStart);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestion((p) => Math.min(p + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestion((p) => Math.max(p - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (suggestions.length > 0) {
        e.preventDefault();
        applySuggestion(suggestions[selectedSuggestion]);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  function applySuggestion(s: Suggestion) {
    if (!textareaRef.current) return;
    const beforeCursor = content.slice(0, cursorPosition);
    const afterCursor = content.slice(cursorPosition);
    const currentLine = beforeCursor.split("\n").pop() || "";
    const lineStart = beforeCursor.length - currentLine.length;
    const newContent = content.slice(0, lineStart) + s.insert + afterCursor;
    const newPos = lineStart + s.insert.length;
    setContent(newContent);
    setModified(true);
    setShowSuggestions(false);
    requestAnimationFrame(() => {
      textareaRef.current!.selectionStart = newPos;
      textareaRef.current!.selectionEnd = newPos;
      textareaRef.current!.focus();
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/env-vars`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
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

  function highlightContent(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        if (line.startsWith("#"))
          return `<span class="text-zinc-500">${esc(line)}</span>`;
        const eq = line.indexOf("=");
        if (eq === -1) return esc(line);
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        return `<span class="text-amber-400">${esc(key)}</span><span class="text-zinc-500">=</span>${esc(val)}`;
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
    <Card className="squircle rounded-lg">
      <CardContent className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Shared across all projects. Reference with{" "}
          <code className="bg-muted px-1 py-0.5 rounded">{"${org.KEY}"}</code>. Press Tab for autocomplete.
        </p>
        <Button size="sm" onClick={handleSave} disabled={saving || !modified}>
          {saving ? (
            <><Loader2 className="mr-1.5 size-4 animate-spin" />Saving...</>
          ) : modified ? "Save Changes" : "Saved"}
        </Button>
      </div>

      <div className="relative rounded-lg border bg-zinc-950 min-h-[400px]">
        <div
          className="absolute inset-0 p-4 font-mono text-sm leading-6 whitespace-pre-wrap overflow-auto pointer-events-none"
          aria-hidden
        >
          {content ? (
            <div dangerouslySetInnerHTML={{ __html: highlightContent(content) }} />
          ) : (
            <span className="text-zinc-600">{"# Organization-wide shared variables\n# Available to all projects via ${org.KEY}\n\nAPI_KEY=your-api-key\nSMTP_HOST=smtp.example.com"}</span>
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={(e) => { setCursorPosition(e.currentTarget.selectionStart); setShowSuggestions(false); }}
          className="relative w-full p-4 font-mono text-sm leading-6 text-transparent caret-zinc-400 bg-transparent resize-none focus:outline-none min-h-[400px] selection:bg-zinc-700/50"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />

        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-72 rounded-lg border bg-popover p-1 shadow-lg" style={{ left: "1rem" }}>
            {suggestions.slice(0, 8).map((s, i) => (
              <button
                key={s.label}
                type="button"
                className={`flex items-center justify-between w-full rounded-md px-3 py-1.5 text-sm ${
                  i === selectedSuggestion ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                }`}
                onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
                onMouseEnter={() => setSelectedSuggestion(i)}
              >
                <span className="font-mono text-xs">{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      </CardContent>
    </Card>
  );
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
