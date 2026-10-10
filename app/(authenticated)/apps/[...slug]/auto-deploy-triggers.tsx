"use client";

import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/ui/relative-time";

type Triggers = {
  autoDeploy: boolean;
  git: boolean;
  webhook: boolean;
  relaySources: number;
  poll: { intervalMinutes: number; checkedAt: string | null; error: string | null };
};

function Row({ on, label, detail }: { on: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span
        className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${on ? "bg-status-success" : "bg-status-neutral"}`}
        aria-hidden="true"
      />
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground">{detail}</span>
    </li>
  );
}

/** Which triggers deploy this app on a push: GitHub webhook, a relay from a linked instance, or the poller. */
export function AutoDeployTriggers({ orgId, appId }: { orgId: string; appId: string }) {
  const [data, setData] = useState<Triggers | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/organizations/${orgId}/apps/${appId}/auto-deploy`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => !cancelled && setData(json))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgId, appId]);

  if (!data || !data.git) return null;

  const { poll } = data;
  const pollDetail =
    poll.intervalMinutes === 0
      ? "Off for this instance"
      : poll.error
        ? `Last check failed: ${poll.error}`
        : poll.checkedAt
          ? `Every ${poll.intervalMinutes} min. Checked for changes ${formatRelativeTime(poll.checkedAt)}`
          : `Every ${poll.intervalMinutes} min. Not checked yet`;

  return (
    <div className="grid gap-1.5 pl-10">
      <p className="text-xs text-muted-foreground">
        {data.autoDeploy ? "A push deploys this app through:" : "Turn on auto deploy to use these triggers:"}
      </p>
      <ul className="grid gap-1">
        <Row on={data.webhook} label="Webhook" detail={data.webhook ? "From the GitHub App" : "No GitHub App webhook here"} />
        <Row
          on={data.relaySources > 0}
          label="Relay"
          detail={
            data.relaySources > 0
              ? `From ${data.relaySources} linked instance${data.relaySources === 1 ? "" : "s"}`
              : "No linked instance relays here"
          }
        />
        <Row on={poll.intervalMinutes > 0 && !poll.error} label="Poll" detail={pollDetail} />
      </ul>
    </div>
  );
}
