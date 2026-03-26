"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "@/lib/messenger";

/**
 * Shared hook for loading and saving a system setting panel.
 * Handles fetch, save, loading/saving states, and error toasts.
 */
export function useSystemSetting<T extends Record<string, unknown>>(
  endpoint: string,
  opts: {
    /** Friendly name for toast messages (e.g. "Email settings") */
    label: string;
    /** Called with fetched data to populate component state */
    onLoad: (data: T) => void;
    /** Called after a successful save */
    onSaved?: () => void;
  },
) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = (await res.json()) as T & { configured?: boolean };
      if (data.configured) {
        setConfigured(true);
        opts.onLoad(data);
      }
    } catch {
      // Not configured — leave defaults
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const msg = body?.error ?? "Failed to save";
          throw new Error(msg);
        }
        toast.success(`${opts.label} saved`);
        setConfigured(true);
        opts.onSaved?.();
        fetchConfig();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : `Failed to save ${opts.label.toLowerCase()}`,
        );
        // Reload server state so optimistic UI updates roll back
        fetchConfig();
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, opts.label, fetchConfig],
  );

  return { loading, saving, configured, save, refetch: fetchConfig };
}
