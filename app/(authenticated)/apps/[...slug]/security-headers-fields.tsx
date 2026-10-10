"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Term } from "@/components/term";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  HSTS_MAX_AGES,
  PERMISSIONS_PRESET,
  applyHeaderPreset,
  headerConfigProblems,
  matchingPreset,
  type Framing,
  type PermissionsMode,
  type ReferrerPolicy,
  type SecurityHeaderConfig,
} from "@/lib/security/response-headers";

const FRAMING_LABEL: Record<Framing, string> = {
  sameorigin: "Same site only",
  deny: "Block entirely",
  off: "Off",
};

const FRAMING_HINT: Record<Framing, string> = {
  sameorigin: "X-Frame-Options: SAMEORIGIN",
  deny: "X-Frame-Options: DENY",
  off: "The app's own setting, if any, applies.",
};

const REFERRER_LABEL: Record<ReferrerPolicy, string> = {
  "strict-origin-when-cross-origin": "Full address on this site, domain elsewhere",
  "no-referrer": "Never send",
  "same-origin": "This site only",
  origin: "Domain only",
  off: "Off",
};

const PERMISSIONS_LABEL: Record<PermissionsMode, string> = {
  off: "Off",
  preset: "Turn off camera, microphone and location",
  custom: "Custom",
};

/** Per-header security settings for an app's HTTPS responses. */
export function SecurityHeadersFields({
  value,
  onChange,
  live,
}: {
  value: SecurityHeaderConfig;
  onChange: (next: SecurityHeaderConfig) => void;
  /** The app's routers already reference the headers file. */
  live: boolean;
}) {
  const preset = matchingPreset(value);
  const problems = headerConfigProblems(value);
  const set = (patch: Partial<SecurityHeaderConfig>) => onChange({ ...value, ...patch });
  const setHsts = (patch: Partial<SecurityHeaderConfig["hsts"]>) => set({ hsts: { ...value.hsts, ...patch } });
  // Open on load when an optional header is on.
  const [advancedOpen] = useState(value.permissionsPolicy.mode !== "off" || value.cspReportOnly.enabled);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid max-w-prose gap-0.5">
          <Label>Security headers</Label>
          <p className="text-xs text-muted-foreground">
            Added to HTTPS responses. Vardo&apos;s value replaces the app&apos;s own for the same header, so turn off any header the app sets itself.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant={preset === "recommended" ? "secondary" : "outline"}
            aria-pressed={preset === "recommended"}
            onClick={() => onChange(applyHeaderPreset(value, "recommended"))}
          >
            Recommended
          </Button>
          <Button
            type="button"
            size="xs"
            variant={preset === "off" ? "secondary" : "outline"}
            aria-pressed={preset === "off"}
            onClick={() => onChange(applyHeaderPreset(value, "off"))}
          >
            Off
          </Button>
        </div>
      </div>

      {/* HSTS */}
      <div className="grid gap-3">
        <div className="flex items-center gap-3">
          <Switch id="edit-hsts" checked={value.hsts.enabled} onCheckedChange={(enabled) => setHsts({ enabled })} />
          <div className="grid gap-0.5">
            <Label htmlFor="edit-hsts">
              <Term id="hsts">HSTS</Term>
            </Label>
            <p className="text-xs text-muted-foreground">Browsers reach this domain over HTTPS only.</p>
          </div>
        </div>
        {value.hsts.enabled && (
          <div className="grid gap-3 pl-11">
            <div className="grid gap-2 sm:w-1/2">
              <Label htmlFor="edit-hsts-max-age">Remember for</Label>
              <Select value={String(value.hsts.maxAge)} onValueChange={(v) => setHsts({ maxAge: Number(v) })}>
                <SelectTrigger id="edit-hsts-max-age">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HSTS_MAX_AGES.map((a) => (
                    <SelectItem key={a.seconds} value={String(a.seconds)}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="edit-hsts-subdomains"
                size="sm"
                checked={value.hsts.includeSubDomains}
                onCheckedChange={(includeSubDomains) => setHsts({ includeSubDomains })}
              />
              <Label htmlFor="edit-hsts-subdomains" className="font-normal">Include subdomains</Label>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id="edit-hsts-preload"
                size="sm"
                className="mt-0.5"
                checked={value.hsts.preload}
                onCheckedChange={(preload) => setHsts({ preload })}
              />
              <div className="grid gap-0.5">
                <Label htmlFor="edit-hsts-preload" className="font-normal">Preload</Label>
                <p className={value.hsts.preload ? "text-xs text-status-warning" : "text-xs text-muted-foreground"}>
                  Hard to undo. Once browsers ship this domain on their preload list, removal takes months. Every subdomain must serve HTTPS until then.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* nosniff */}
      <div className="flex items-center gap-3">
        <Switch id="edit-nosniff" checked={value.nosniff} onCheckedChange={(nosniff) => set({ nosniff })} />
        <div className="grid gap-0.5">
          <Label htmlFor="edit-nosniff">Block content-type guessing</Label>
          <p className="text-xs text-muted-foreground font-mono">X-Content-Type-Options: nosniff</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="edit-framing">
            <Term id="framing">Framing</Term>
          </Label>
          <Select value={value.framing} onValueChange={(v) => set({ framing: v as Framing })}>
            <SelectTrigger id="edit-framing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FRAMING_LABEL) as Framing[]).map((f) => (
                <SelectItem key={f} value={f}>{FRAMING_LABEL[f]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className={value.framing === "off" ? "text-xs text-muted-foreground" : "text-xs text-muted-foreground font-mono"}>
            {FRAMING_HINT[value.framing]}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="edit-referrer">
            <Term id="referrer-policy">Referrer policy</Term>
          </Label>
          <Select value={value.referrerPolicy} onValueChange={(v) => set({ referrerPolicy: v as ReferrerPolicy })}>
            <SelectTrigger id="edit-referrer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(REFERRER_LABEL) as ReferrerPolicy[]).map((r) => (
                <SelectItem key={r} value={r}>{REFERRER_LABEL[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className={value.referrerPolicy === "off" ? "text-xs text-muted-foreground" : "text-xs text-muted-foreground font-mono"}>
            {value.referrerPolicy === "off" ? "The app's own setting, if any, applies." : value.referrerPolicy}
          </p>
        </div>
      </div>

      <details className="group grid gap-4" open={advancedOpen}>
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <DisclosureChevron />
          More headers
        </summary>
        <div className="mt-3 grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="edit-permissions-policy">
              <Term id="permissions-policy">Permissions policy</Term>
            </Label>
            <div className="sm:w-1/2">
              <Select
                value={value.permissionsPolicy.mode}
                onValueChange={(v) => set({ permissionsPolicy: { ...value.permissionsPolicy, mode: v as PermissionsMode } })}
              >
                <SelectTrigger id="edit-permissions-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PERMISSIONS_LABEL) as PermissionsMode[]).map((m) => (
                    <SelectItem key={m} value={m}>{PERMISSIONS_LABEL[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {value.permissionsPolicy.mode === "preset" && (
              <p className="text-xs text-muted-foreground font-mono">{PERMISSIONS_PRESET}</p>
            )}
            {value.permissionsPolicy.mode === "custom" && (
              <>
                <Input
                  aria-label="Permissions policy"
                  className="font-mono text-xs"
                  placeholder="camera=(), microphone=(self)"
                  value={value.permissionsPolicy.custom}
                  onChange={(e) => set({ permissionsPolicy: { ...value.permissionsPolicy, custom: e.target.value } })}
                  aria-invalid={!!problems.permissionsPolicy}
                />
                {problems.permissionsPolicy && <p className="text-xs text-destructive">{problems.permissionsPolicy}</p>}
              </>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-3">
              <Switch
                id="edit-csp-report-only"
                checked={value.cspReportOnly.enabled}
                onCheckedChange={(enabled) => set({ cspReportOnly: { ...value.cspReportOnly, enabled } })}
              />
              <Label htmlFor="edit-csp-report-only">
                <Term id="csp-report-only">CSP report-only</Term>
              </Label>
            </div>
            {value.cspReportOnly.enabled && (
              <>
                <Textarea
                  aria-label="Content Security Policy"
                  className="font-mono text-xs"
                  rows={3}
                  placeholder="default-src 'self'; img-src 'self' data:"
                  value={value.cspReportOnly.policy}
                  onChange={(e) => set({ cspReportOnly: { ...value.cspReportOnly, policy: e.target.value } })}
                  aria-invalid={!!problems.cspReportOnly}
                />
                {problems.cspReportOnly ? (
                  <p className="text-xs text-destructive">{problems.cspReportOnly}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Directives separated by semicolons.
                    {value.framing !== "off" && " Vardo adds frame-ancestors to match the framing setting."}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </details>

      {!live && (
        <p className="text-xs text-muted-foreground">
          Redeploy once to start applying these. After that, changes apply when you save.
        </p>
      )}
    </div>
  );
}
