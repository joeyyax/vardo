"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";

// ---------------------------------------------------------------------------
// Clipboard toast helper
// ---------------------------------------------------------------------------

const clipboardIcon = <ClipboardCheck className="size-4" />;

function copyToast(value: string) {
  navigator.clipboard.writeText(value);
  toast.success("Copied to clipboard", {
    icon: clipboardIcon,
    description: value,
    classNames: { description: "font-mono" },
  });
}

// ---------------------------------------------------------------------------
// .env language mode
// ---------------------------------------------------------------------------

const envParser: StreamParser<{ inValue: boolean }> = {
  startState: () => ({ inValue: false }),
  token(stream, state) {
    // Start of line
    if (stream.sol()) {
      state.inValue = false;
      // Comment
      if (stream.match(/^#.*/)) return "comment";
    }

    // Key before =
    if (!state.inValue) {
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "propertyName";
      if (stream.eat("=")) {
        state.inValue = true;
        return "operator";
      }
      stream.next();
      return null;
    }

    // Value side — highlight ${...} refs
    if (stream.match(/^\$\{[^}]*\}/)) return "variableName";
    stream.next();
    return "string";
  },
};

const envLang = new LanguageSupport(StreamLanguage.define(envParser));

// ---------------------------------------------------------------------------
// CodeMirror theme (matches the dark zinc editor)
// ---------------------------------------------------------------------------

const envTheme = createTheme({
  theme: "dark",
  settings: {
    background: "rgb(9 9 11)", // zinc-950
    foreground: "rgb(228 228 231)", // zinc-200
    caret: "rgb(161 161 170)", // zinc-400
    selection: "rgba(63 63 70 / 0.5)", // zinc-700/50
    selectionMatch: "rgba(63 63 70 / 0.3)",
    lineHighlight: "rgba(39 39 42 / 0.5)", // zinc-800/50
    gutterBackground: "transparent",
    gutterForeground: "rgb(82 82 91)", // zinc-600
  },
  styles: [
    { tag: tags.comment, color: "rgb(113 113 122)" }, // zinc-500
    { tag: tags.propertyName, color: "rgb(251 191 36)" }, // amber-400
    { tag: tags.operator, color: "rgb(113 113 122)" }, // zinc-500
    { tag: tags.string, color: "rgb(228 228 231)" }, // zinc-200
    { tag: tags.variableName, color: "rgb(34 211 238)" }, // cyan-400
  ],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EnvEditorProps = {
  appId: string;
  appName: string;
  orgId: string;
  initialVars: { key: string; isSecret: boolean | null }[];
  allAppNames?: string[];
  orgVarKeys?: string[];
  environmentId?: string;
} | {
  standalone: true;
  initialContent?: string;
  onChange: (content: string) => void;
  allAppNames?: string[];
  orgVarKeys?: string[];
  showReferences?: boolean;
};

const PASSWORD_KEYS = ["password", "secret", "_key", "jwt"];
function isPasswordKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PASSWORD_KEYS.some((p) => lower.includes(p));
}

// ---------------------------------------------------------------------------
// Editor extensions (stable reference)
// ---------------------------------------------------------------------------

const baseExtensions = [
  envLang,
  envTheme,
  EditorView.lineWrapping,
  EditorState.tabSize.of(2),
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EnvEditor(props: EnvEditorProps) {
  const isStandalone = "standalone" in props && props.standalone;
  const appId = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).appId;
  const appName = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).appName;
  const orgId = isStandalone ? "" : (props as Exclude<EnvEditorProps, { standalone: true }>).orgId;
  const environmentId = isStandalone ? undefined : (props as Exclude<EnvEditorProps, { standalone: true }>).environmentId;

  const router = useRouter();
  const [content, setContentState] = useState(isStandalone ? (props.initialContent || "") : "");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(isStandalone);
  const [modified, setModified] = useState(false);
  const [needsRedeploy, setNeedsRedeploy] = useState(false);
  const [passwordWarning, setPasswordWarning] = useState<string | null>(null);
  const [initialContent, setInitialContent] = useState(isStandalone ? (props.initialContent || "") : "");

  // Copy chips state
  const [hoveredLine, setHoveredLine] = useState<number>(-1);
  const [selectedLineSet, setSelectedLineSet] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  // Track CodeMirror selection to detect multi-line selections
  const updateSelectionFromView = useCallback(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) {
      setSelectedLineSet(new Set());
      return;
    }
    const startLine = view.state.doc.lineAt(from).number - 1; // 0-indexed
    const endLine = view.state.doc.lineAt(to).number - 1;
    if (startLine === endLine) {
      setSelectedLineSet(new Set());
      return;
    }
    const lines = new Set<number>();
    for (let i = startLine; i <= endLine; i++) lines.add(i);
    setSelectedLineSet(lines);
  }, []);

  // Extensions with selection listener
  const extensions = useMemo(
    () => [
      ...baseExtensions,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) {
          updateSelectionFromView();
        }
      }),
    ],
    [updateSelectionFromView]
  );

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

  // Load current env vars (skip in standalone mode)
  useEffect(() => {
    if (isStandalone) return;
    async function load() {
      try {
        const params = new URLSearchParams();
        if (environmentId) params.set("environmentId", environmentId);
        const qs = params.toString();
        const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}/env-vars${qs ? `?${qs}` : ""}`);
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
  }, [orgId, appId, environmentId, isStandalone]);

  function handleChange(value: string) {
    setContent(value);
    setModified(true);

    // Check for password changes on persistent services
    const changedLines = value.split("\n").filter((line) => {
      if (!line.includes("=") || line.startsWith("#")) return false;
      const key = line.split("=")[0].trim();
      if (!isPasswordKey(key)) return false;
      const initialLine = initialContent.split("\n").find((l) => l.startsWith(`${key}=`));
      return initialLine !== line;
    });
    setPasswordWarning(
      changedLines.length > 0
        ? `Changing ${changedLines.map((l) => l.split("=")[0]).join(", ")} won't update existing data in persistent volumes. You may need to manually update the service.`
        : null
    );
  }

  async function doSave(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/env-vars`,
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
    const saved = await doSave();
    if (saved) router.refresh();
  }

  // Mouse tracking for copy chips
  function handleMouseMove(e: React.MouseEvent) {
    const view = cmRef.current?.view;
    if (!view) return;
    const rect = view.dom.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const block = view.lineBlockAtHeight(y + view.scrollDOM.scrollTop);
    const lineNum = view.state.doc.lineAt(block.from).number - 1; // 0-indexed
    setHoveredLine(lineNum);
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Compute copy chip data
  const lines = content.split("\n");
  const btnClass = "px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800/80 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 hover:bg-zinc-700 transition-colors";

  function renderCopyChips() {
    // Multi-line selection mode
    if (selectedLineSet.size > 1) {
      const indices = Array.from(selectedLineSet).sort((a, b) => a - b);
      const selected = indices
        .filter((i) => i < lines.length)
        .map((i) => lines[i])
        .filter((l) => l.includes("=") && !l.startsWith("#") && l.trim());
      if (selected.length === 0) return null;

      const keys = selected.map((l) => l.slice(0, l.indexOf("=")).trim());
      const values = selected.map((l) => l.slice(l.indexOf("=") + 1));
      const count = selected.length;

      // Position at first selected line
      const view = cmRef.current?.view;
      if (!view) return null;
      const firstLine = view.state.doc.line(indices[0] + 1);
      const block = view.lineBlockAt(firstLine.from);
      const top = block.top;

      return (
        <div
          className="absolute right-3 flex items-center gap-1.5 h-6 pointer-events-auto z-10"
          style={{ top }}
        >
          <span className="text-[10px] font-mono text-zinc-600">copy {count} vars</span>
          <button type="button" className={btnClass} onClick={() => copyToast(keys.join("\n"))}>keys</button>
          <button type="button" className={btnClass} onClick={() => copyToast(values.join("\n"))}>values</button>
          <button type="button" className={btnClass} onClick={() => copyToast(selected.join("\n"))}>pairs</button>
          {appName && (
            <button type="button" className={btnClass} onClick={() => {
              copyToast(keys.map((k) => `\${${appName}.${k}}`).join("\n"));
            }}>$&#123;vars&#125;</button>
          )}
        </div>
      );
    }

    // Single line hover mode
    if (hoveredLine < 0 || hoveredLine >= lines.length) return null;
    const line = lines[hoveredLine];
    const eqIdx = line.indexOf("=");
    if (!line.trim() || line.startsWith("#") || eqIdx === -1) return null;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1);
    const varRef = appName ? `\${${appName}.${key}}` : null;

    // Get pixel position from CodeMirror
    const view = cmRef.current?.view;
    if (!view) return null;
    const cmLine = view.state.doc.line(hoveredLine + 1);
    const block = view.lineBlockAt(cmLine.from);
    const top = block.top;

    return (
      <div
        className="absolute right-3 flex items-center gap-1.5 h-6 pointer-events-auto z-10"
        style={{ top }}
      >
        <span className="text-[10px] font-mono text-zinc-600">copy</span>
        <button type="button" className={btnClass} onClick={() => copyToast(line)}>pair</button>
        <button type="button" className={btnClass} onClick={() => copyToast(key)}>key</button>
        <button type="button" className={btnClass} onClick={() => copyToast(value)}>value</button>
        {varRef && (
          <button type="button" className={btnClass} onClick={() => copyToast(varRef)}>$&#123;var&#125;</button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Restart needed banner */}
      {!isStandalone && needsRedeploy && !modified && (
        <div className="flex items-center gap-2 rounded-lg border border-status-warning/30 bg-status-warning-muted px-4 py-3">
          <AlertTriangle className="size-4 text-status-warning shrink-0" />
          <p className="text-sm text-status-warning">
            Variables saved. Restart the app to apply changes.
          </p>
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
          KEY=value format. <kbd className="bg-muted px-1 py-0.5 rounded text-[10px]">Cmd+D</kbd> select next occurrence. <kbd className="bg-muted px-1 py-0.5 rounded text-[10px]">Alt+↑↓</kbd> move lines.
        </p>
        {!isStandalone && (
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !modified}
          >
            {saving ? (
              <><Loader2 className="mr-1.5 size-4 animate-spin" />Saving...</>
            ) : (
              "Save"
            )}
          </Button>
        )}
      </div>

      <div
        ref={containerRef}
        className="relative rounded-lg border bg-zinc-950 overflow-hidden"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredLine(-1)}
      >
        <CodeMirror
          ref={cmRef}
          value={content}
          onChange={handleChange}
          extensions={extensions}
          placeholder="# Environment variables&#10;DATABASE_URL=postgres://localhost:5432/mydb&#10;REDIS_URL=redis://localhost:6379"
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            bracketMatching: false,
            closeBrackets: false,
            autocompletion: false,
            indentOnInput: false,
          }}
          minHeight="400px"
          className="[&_.cm-editor]:!bg-transparent [&_.cm-gutters]:!bg-transparent [&_.cm-gutters]:!border-0 [&_.cm-focused]:!outline-none [&_.cm-scroller]:!font-mono [&_.cm-content]:!py-0"
        />

        {/* Copy chips overlay */}
        {content && renderCopyChips()}
      </div>
    </div>
  );
}
