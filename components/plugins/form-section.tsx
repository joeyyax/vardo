"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FieldOption = {
  label: string;
  value: string;
};

type FormField = {
  key: string;
  type: string;
  label: string;
  description?: string;
  default?: unknown;
  options?: FieldOption[];
  required?: boolean;
};

type FormSectionProps = {
  title: string;
  description?: string;
  fields?: FormField[];
  dataSource?: string;
};

export function FormSection({
  title,
  description,
  fields: fieldsProp,
  dataSource,
}: FormSectionProps) {
  const [fields, setFields] = useState<FormField[]>(fieldsProp ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load current values (and optionally field definitions) from the data source
  useEffect(() => {
    if (!dataSource) {
      // No data source — initialize defaults from field declarations
      if (fieldsProp?.length) {
        const defaults: Record<string, string> = {};
        for (const field of fieldsProp) {
          defaults[field.key] = String(field.default ?? "");
        }
        setValues(defaults);
      }
      return;
    }

    setLoading(true);
    fetch(dataSource)
      .then((r) => r.json())
      .then((data) => {
        // API can return fields if none were passed via props
        if (!fieldsProp?.length && data.fields) {
          setFields(data.fields);
        }

        const loaded: Record<string, string> = {};
        const settingsData = data.settings ?? data.values ?? data;
        const activeFields = fieldsProp?.length ? fieldsProp : data.fields ?? [];

        for (const field of activeFields) {
          loaded[field.key] =
            settingsData[field.key] != null
              ? String(settingsData[field.key])
              : String(field.default ?? "");
        }
        setValues(loaded);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dataSource, fieldsProp]);

  const handleChange = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!dataSource) return;

    setSaving(true);
    try {
      const res = await fetch(dataSource, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error();
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }, [dataSource, values]);

  if (loading) {
    return (
      <div className="squircle border bg-card p-6">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="squircle border bg-card p-6">
        <h3 className="text-sm font-medium">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          No configurable settings.
        </p>
      </div>
    );
  }

  return (
    <div className="squircle border bg-card p-6">
      <div className="mb-4">
        <h3 className="text-sm font-medium">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      <div className="space-y-4">
        {fields.map((field) => (
          <FieldRenderer
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            onChange={(v) => handleChange(field.key, v)}
          />
        ))}
      </div>

      {dataSource && (
        <div className="mt-6">
          <Button
            onClick={handleSave}
            disabled={saving}
            size="sm"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `field-${field.key}`;

  return (
    <div className="space-y-1.5">
      {field.type === "toggle" ? (
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor={id}>{field.label}</Label>
            {field.description && (
              <p className="text-xs text-muted-foreground">
                {field.description}
              </p>
            )}
          </div>
          <Switch
            id={id}
            checked={value === "true"}
            onCheckedChange={(checked) => onChange(String(checked))}
          />
        </div>
      ) : (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          {field.description && (
            <p className="text-xs text-muted-foreground">
              {field.description}
            </p>
          )}
          {field.type === "text" && (
            <input
              id={id}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="squircle w-full border bg-background px-3 py-1.5 text-sm"
              placeholder={field.default ? String(field.default) : undefined}
              required={field.required}
            />
          )}
          {field.type === "password" && (
            <input
              id={id}
              type="password"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="squircle w-full border bg-background px-3 py-1.5 text-sm"
              required={field.required}
            />
          )}
          {field.type === "number" && (
            <input
              id={id}
              type="number"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="squircle w-full border bg-background px-3 py-1.5 text-sm"
              placeholder={field.default ? String(field.default) : undefined}
              required={field.required}
            />
          )}
          {field.type === "textarea" && (
            <textarea
              id={id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={4}
              className="squircle w-full border bg-background px-3 py-1.5 text-sm"
              placeholder={field.default ? String(field.default) : undefined}
              required={field.required}
            />
          )}
          {field.type === "select" && field.options && (
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      )}
    </div>
  );
}
