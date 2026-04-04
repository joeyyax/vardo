"use client";

/**
 * PluginSettingsForm — renders a plugin's settings from its manifest declaration.
 *
 * Takes an array of PluginSettingField and renders the appropriate form controls.
 * Reads current values from the plugin settings API, writes changes back.
 * Uses the same shadcn/ui components as the rest of the app — feels native.
 */

import { useEffect, useState, useCallback } from "react";
import { toast } from "@/lib/messenger";
import type { PluginSettingField } from "@/lib/plugins/manifest";

type PluginSettingsFormProps = {
  pluginId: string;
  fields: PluginSettingField[];
  organizationId?: string;
};

export function PluginSettingsForm({ pluginId, fields, organizationId }: PluginSettingsFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Load current values
  useEffect(() => {
    const params = new URLSearchParams({ pluginId });
    if (organizationId) params.set("organizationId", organizationId);

    fetch(`/api/v1/plugins/settings?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const loaded: Record<string, string> = {};
        for (const field of fields) {
          loaded[field.key] = data.settings?.[field.key] ?? String(field.default ?? "");
        }
        setValues(loaded);
      })
      .catch(() => {});
  }, [pluginId, organizationId, fields]);

  const handleChange = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fetch("/api/v1/plugins/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId, organizationId, settings: values }),
      });
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }, [pluginId, organizationId, values]);

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <FieldRenderer
          key={field.key}
          field={field}
          value={values[field.key] ?? ""}
          onChange={(v) => handleChange(field.key, v)}
        />
      ))}
      <button
        onClick={handleSave}
        disabled={saving}
        className="squircle bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field renderers — one per field type
// ---------------------------------------------------------------------------

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{field.label}</label>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {field.type === "toggle" && (
        <button
          type="button"
          role="switch"
          aria-checked={value === "true"}
          onClick={() => onChange(value === "true" ? "false" : "true")}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${value === "true" ? "bg-primary" : "bg-muted"}`}
        >
          <span
            className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${value === "true" ? "translate-x-4" : "translate-x-0"}`}
          />
        </button>
      )}
      {field.type === "text" && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="squircle w-full border bg-background px-3 py-1.5 text-sm"
          placeholder={field.default ? String(field.default) : undefined}
        />
      )}
      {field.type === "password" && (
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="squircle w-full border bg-background px-3 py-1.5 text-sm"
        />
      )}
      {field.type === "number" && (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="squircle w-full border bg-background px-3 py-1.5 text-sm"
          placeholder={field.default ? String(field.default) : undefined}
        />
      )}
      {field.type === "textarea" && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="squircle w-full border bg-background px-3 py-1.5 text-sm"
          placeholder={field.default ? String(field.default) : undefined}
        />
      )}
      {field.type === "select" && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="squircle w-full border bg-background px-3 py-1.5 text-sm"
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
