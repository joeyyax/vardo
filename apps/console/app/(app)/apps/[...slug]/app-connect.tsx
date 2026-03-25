"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Switch } from "@/components/ui/switch";

import type { EnvVar } from "./types";

export function AppConnect({
  connectionInfo,
  exposedPorts,
  envVars,
  appName,
  appId,
  containerPort,
}: {
  connectionInfo: { label: string; value: string; copyRef?: string }[];
  exposedPorts: { internal: number; external?: number; description?: string }[] | null;
  envVars: EnvVar[];
  appName: string;
  appId: string;
  containerPort: number | null;
}) {
  const [showVarNames, setShowVarNames] = useState(false);

  return (
    <div className="pt-4">
      <div className="space-y-6">
        {/* Internal connection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Internal <span className="text-muted-foreground font-normal">(Docker network)</span></h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{showVarNames ? "Variables" : "Values"}</span>
              <Switch
                checked={showVarNames}
                onCheckedChange={setShowVarNames}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {showVarNames
              ? "Showing variable references — paste these into other apps."
              : "Showing resolved values — toggle to see variable references."}
          </p>
          <div className="rounded-lg border bg-card divide-y">
            {connectionInfo.map((info) => {
              const resolved = info.value
                .replace(/\$\{project\.name\}/g, appName)
                .replace(/\$\{project\.port\}/g, String(containerPort || ""))
                .replace(/\$\{project\.id\}/g, appId)
                .replace(/\$\{([A-Z_]+)\}/g, (_match, key) => {
                  const envVar = envVars.find((v) => v.key === key);
                  return envVar?.value || `\${${key}}`;
                });

              // Build full reference: ${projectName.VAR_KEY}
              const fullRef = info.copyRef
                ? info.copyRef === "HOST"
                  ? `\${${appName}}`
                  : `\${${appName}.${info.copyRef}}`
                : null;
              const displayValue = showVarNames ? (fullRef || resolved) : resolved;
              const copyValue = fullRef || resolved;

              return (
                <div key={info.label} className="flex items-center justify-between px-4 py-3 gap-4">
                  <span className="text-xs text-muted-foreground shrink-0 w-28">{info.label}</span>
                  <span className={`text-sm font-mono truncate flex-1 ${showVarNames ? "text-status-info" : ""}`}>
                    {displayValue}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(copyValue);
                      toast.success(`Copied ${copyValue}`);
                    }}
                    className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title={`Copy: ${copyValue}`}
                  >
                    <Copy className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* External connection */}
        {exposedPorts?.some((p) => p.external) && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">External <span className="text-muted-foreground font-normal">(host ports)</span></h3>
            <p className="text-xs text-muted-foreground">
              Use these to connect from outside Docker (e.g. database tools, local development).
            </p>
            <div className="rounded-lg border bg-card divide-y">
              {exposedPorts
                .filter((p) => p.external)
                .map((p) => (
                  <div key={p.internal} className="flex items-center justify-between px-4 py-3 gap-4">
                    <span className="text-xs text-muted-foreground shrink-0 w-28">
                      {p.description || `Port ${p.internal}`}
                    </span>
                    <span className="text-sm font-mono flex-1">
                      localhost:{p.external}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(`localhost:${p.external}`);
                        toast.success("Copied");
                      }}
                      className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
