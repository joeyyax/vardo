"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Loader2,
  Download,
  Upload,
  FileText,
  ShieldCheck,
  Check,
  Info,
} from "lucide-react";
import { toast } from "@/lib/messenger";

export function ConfigSettings() {
  const [loading, setLoading] = useState(true);
  const [fileStatus, setFileStatus] = useState<{
    config: boolean;
    secrets: boolean;
    configPath: string;
    secretsPath: string;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/config/status");
        if (res.ok) {
          setFileStatus(await res.json());
        }
      } catch {
        // File status check is optional
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleImport(file: File) {
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/v1/admin/config/import?persist=true", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        let message = "Import failed";
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }

      const data = await res.json();
      toast.success(`Config imported: ${data.imported.join(", ")}`);

      if (data.missingSecrets?.length > 0) {
        toast.error(`Missing secrets: ${data.missingSecrets.join(", ")}`, {
          description: "Update these in the relevant settings pages.",
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Configuration</h2>
        <p className="text-sm text-muted-foreground">
          Export your system configuration for backup or migration. Import a config file to restore settings on a new instance.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Export */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Export</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Download your configuration as a portable file. Use it to migrate to a new instance or as a backup.
            </p>
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a href="/api/v1/admin/config/export?include=config">
                  <FileText className="size-4 mr-1.5" aria-hidden="true" />
                  Download config
                </a>
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                >
                  <a href="/api/v1/admin/config/export?include=full">
                    <Download className="size-4 mr-1.5" aria-hidden="true" />
                    Full export (with secrets)
                  </a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Full export includes encryption keys, API keys, and passwords. Keep it secure.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Import */}
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Import</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a vardo.yml, vardo.secrets.yml, or a vardo.zip to restore configuration.
            </p>
            <div>
              <label className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 cursor-pointer hover:bg-muted/50 transition-colors">
                <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">
                  {importing ? "Importing..." : "Drop a file or click to upload"}
                </span>
                <input
                  type="file"
                  accept=".yml,.yaml,.zip"
                  className="sr-only"
                  disabled={importing}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImport(file);
                  }}
                />
              </label>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">What&apos;s included</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Instance settings, domain, feature flags</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Check className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Email, backup, and GitHub App configuration</span>
            </li>
            <li className="flex items-start gap-2.5">
              <ShieldCheck className="size-4 text-status-success shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Secrets file includes encryption keys and API credentials</span>
            </li>
          </ul>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Good to know</h3>
          <ul className="text-sm space-y-2">
            <li className="flex items-start gap-2.5">
              <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Config file (vardo.yml) is safe to share — no secrets</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Secrets file (vardo.secrets.yml) should be kept secure</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="size-4 text-muted-foreground/50 shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-muted-foreground">Does not include user accounts, projects, or volume data</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
