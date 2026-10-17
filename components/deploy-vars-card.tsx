"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { DEPLOY_VAR_KEYS, type DeployVarKey } from "@/lib/docker/deploy-vars";

const DESCRIPTIONS: Record<DeployVarKey, string> = {
  VARDO_GIT_SHA: "Deployed commit",
  VARDO_GIT_BRANCH: "Branch it came from",
  VARDO_DEPLOY_ID: "This deploy's ID",
  VARDO_DEPLOYED_AT: "When it deployed, ISO 8601",
  VARDO_APP_NAME: "App name",
  VARDO_APP_URL: "Primary domain",
  VARDO_ENVIRONMENT: "Environment name",
  VARDO_MEMORY_LIMIT: "Memory limit in bytes",
  VARDO_SLOT: "blue or green",
};

const UNSET: Partial<Record<DeployVarKey, string>> = {
  VARDO_GIT_SHA: "No git source",
  VARDO_GIT_BRANCH: "No git source",
  VARDO_APP_URL: "No domain",
  VARDO_MEMORY_LIMIT: "No limit",
  VARDO_SLOT: "No slot",
};

type Props = {
  orgId: string;
  appId: string;
  environmentId?: string;
  /** Keys the app's own variables set; those win. */
  ownKeys: ReadonlySet<string>;
};

export function DeployVarsCard({ orgId, appId, environmentId, ownKeys }: Props) {
  const [vars, setVars] = useState<Record<string, string> | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const query = environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : "";
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/deploy-vars${query}`)
      .then((res) => (res.ok ? res.json() : { vars: null }))
      .then((data: { vars: Record<string, string> | null }) => live && setVars(data.vars))
      .catch(() => live && setVars(null));
    return () => {
      live = false;
    };
  }, [orgId, appId, environmentId]);

  function valueOf(key: DeployVarKey): { text: string; muted: boolean } {
    if (ownKeys.has(key)) return { text: "Your value", muted: true };
    if (vars === undefined) return { text: "…", muted: true };
    if (vars === null) return { text: "Set on next deploy", muted: true };
    const value = vars[key];
    return value ? { text: value, muted: false } : { text: UNSET[key] ?? "Not set", muted: true };
  }

  return (
    <section aria-labelledby="deploy-vars-heading" className="space-y-3 border-t pt-5">
      <div className="space-y-1">
        <h2 id="deploy-vars-heading" className="flex items-center gap-2 text-sm font-medium">
          <Lock className="size-3.5 text-muted-foreground" aria-hidden />
          Set by Vardo
        </h2>
        <p className="text-sm text-muted-foreground">
          Read-only, from the running deploy. A variable of yours with the same name wins.
        </p>
      </div>
      <dl className="divide-y text-sm">
        {DEPLOY_VAR_KEYS.map((key) => {
          const { text, muted } = valueOf(key);
          return (
            <div key={key} className="grid gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
              <dt className="min-w-0">
                <span className="block truncate font-mono text-xs">{key}</span>
                <span className="block text-xs text-muted-foreground">{DESCRIPTIONS[key]}</span>
              </dt>
              <dd
                className={muted ? "text-xs text-muted-foreground md:self-center" : "min-w-0 break-all font-mono text-xs md:self-center"}
                title={muted ? undefined : text}
              >
                {text}
                {key === "VARDO_MEMORY_LIMIT" && !muted && (
                  <span className="ml-2 font-sans text-muted-foreground">{Math.round(Number(text) / 1024 ** 2)} MB</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
