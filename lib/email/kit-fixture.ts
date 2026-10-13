// Email kit samples for `pnpm email:preview`: every primitive, plus two mockup emails rebuilt from the kit.

import type { NotificationMailBody } from "./templates/components";
import { linkedList, nameLink } from "./templates/components";
import { FIXTURE_CONTEXT } from "./fixtures";
import { footerFor } from "./templates/context";

const url = (path: string) => `${FIXTURE_CONTEXT.baseUrl}${path}`;
const footer = footerFor(FIXTURE_CONTEXT);

const kit: NotificationMailBody = {
  tone: "info",
  status: "Kit",
  heading: "Email kit",
  blocks: [
    { kind: "text", text: ["Every primitive in order. Names like ", nameLink("acme-web", url("/apps/app_9xk2")), " link with a subtle underline."] },
    { kind: "reassure", strong: "Nothing is down.", text: "The previous version is still serving." },
    {
      kind: "callout",
      tone: "bad",
      title: "Meilisearch crashed on start",
      body: "Its database is version 1.13.3 and the new engine is 1.54.3, so it refuses to open the data.",
      action: { label: "Meilisearch upgrade guide", href: "https://www.meilisearch.com/docs" },
    },
    {
      kind: "callout",
      tone: "warn",
      title: [nameLink("Shop Staging", url("/apps/app_stg")), " / uploads is 95% smaller than usual"],
      body: "100 MiB tonight, usually 1.8 GiB.",
      visual: { kind: "columns", compact: true, columns: [18, 18, 18, 18, 19, 18, 1].map((value, i) => ({ parts: [{ value, tone: i === 6 ? ("fail" as const) : undefined }] })), caption: "Last 7 nights" },
      action: { label: "Check the volume", href: url("/backups") },
    },
    {
      kind: "tiles",
      tiles: [
        { label: "Deploys", value: "1,104", unit: "/1,130", sub: "95% succeeded" },
        { label: "Size", value: "9.8", unit: " GiB", sub: "+1% from last night" },
        { label: "Uptime", value: "99.98", unit: "%", sub: "9 min down" },
        { label: "CPU", value: "2", unit: "%", sub: "peak 31%" },
        { label: "Memory", value: "0.9", unit: " GB", sub: "peak 1.88 of 2 GB", hot: true },
        { label: "App", value: "acme-web", href: url("/apps/app_9xk2"), sub: "Acme Nonprofit" },
      ],
    },
    { kind: "section", title: "Stats table" },
    {
      kind: "stats",
      columns: ["App", "CPU", "Memory", "Storage"],
      rows: [
        { name: "paperless", href: url("/apps/a1"), why: ["paperless-media isn't backed up · ", nameLink("Set up", url("/backups"))], cells: ["3%", "420 MB", "18 GB"] },
        { name: "qbittorrent", href: url("/apps/a2"), sub: "media", cells: ["12%", { value: "1 GB", sub: "at limit", hot: true }, "640 GB"] },
        { name: "Vardo", sub: "postgres", cells: ["1%", "2.2 GiB", "—"] },
      ],
      footer: ["and 18 more apps · ", nameLink("View all", url("/apps"))],
    },
    { kind: "section", title: "Host" },
    {
      kind: "stats",
      columns: ["Resource", { label: "Daily peak", align: "left", width: "44%" }, "Now", "Peak"],
      rows: [
        { name: "CPU", cells: [{ value: "", spark: [32, 28, 30, 43, 29, 25, 22, 31, 35, 30, 27, 24, 20, 19, 26, 30, 33, 28, 31, 22] }, "12%", "43%"] },
        { name: "Disk", cells: [{ value: "", spark: [80, 81, 82, 84, 84, 85, 85, 84, 83, 72, 68, 66, 65, 65, 66, 65, 65, 65, 66, 65] }, "65%", "85%"] },
      ],
    },
    { kind: "facts", facts: [
      { label: "Project", value: "Acme Nonprofit · production", rich: [nameLink("Acme Nonprofit", url("/projects/p1")), " · production"] },
      { label: "Ports", value: "tcp/32400, tcp/8080", rich: [{ chip: "tcp/32400" }, { chip: "tcp/8080 · new", new: true }] },
      { label: "Command", value: "wp cron event run --due-now", rich: [{ text: "wp cron event run --due-now", mono: true }] },
    ] },
    { kind: "chips", chips: [{ text: "exposed files" }, { text: "headers" }, { text: "TLS" }, { text: "open ports", new: true }] },
    { kind: "phases", title: "Where the time went", steps: [
      { label: "Clone", value: 3, detail: "3s" },
      { label: "Build", value: 69, detail: "1m 04s" },
      { label: "Pull", value: 5, detail: "5s" },
      { label: "Start", value: 7, detail: "6s" },
      { label: "Health", value: 14, detail: "13s", failed: true },
      { label: "Cleanup", value: 2, detail: "2s" },
    ] },
    { kind: "section", title: "Threshold gauge" },
    { kind: "gauge", percent: 91, warn: 85, critical: 95, label: "204 of 223.4 GiB" },
    { kind: "gauge", percent: 62, warn: 85, critical: 95, label: "19.8 of 31.9 GiB" },
    { kind: "section", title: "Docker data, last 24 hours" },
    { kind: "columns", baseline: "auto", columns: [150, 150, 151, 151, 151, 152, 152, 152, 153, 153, 153, 154, 158, 159, 160, 160, 161, 161, 162, 162, 163, 163, 164, 165].map((value) => ({ parts: [{ value }] })) },
    { kind: "section", title: "Written per hour" },
    { kind: "columns", columns: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 6, 7, 8].map((value, i) => ({ parts: [{ value, tone: i >= 20 ? ("warn" as const) : undefined }] })), axis: ["24 h ago", "now"] },
    { kind: "section", title: "Last 24 runs" },
    { kind: "days", days: Array.from({ length: 24 }, (_, i) => (i === 23 ? "fail" : "ok")) },
    { kind: "section", title: "Busiest hours" },
    { kind: "hours", values: [1, 1, 1, 1, 1, 1, 1, 3, 6, 10, 10, 7, 7, 7, 4, 4, 4, 4, 2, 2, 1, 1, 1, 1] },
    { kind: "section", title: "Storage" },
    { kind: "volumes", rows: [
      { name: "immich-library", size: "212 GB", change: "+9 GB", value: 212, flag: "no backups" },
      { name: "immich-postgres", size: "1.6 GB", change: "+80 MB", value: 1.6 },
      { name: "immich-model-cache", size: "640 MB", change: "no change", value: 0.64 },
    ], caption: "Bars compare this app's volumes. Change is since deploy." },
    { kind: "timeline", current: 1, steps: [{ label: "Deployed", date: "Oct 13" }, { label: "Baseline set", date: "Oct 16" }, { label: "First month", date: "Nov 12" }] },
    { kind: "section", title: "Last log lines" },
    { kind: "log", lines: [
      "meilisearch-1 | Starting Meilisearch",
      "meilisearch-1 | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
      "meilisearch-1 exited with code 1 (restarting)",
    ] },
    { kind: "note", text: ["Linked list: ", ...linkedList([{ text: "gitea", href: url("/apps/g") }, { text: "dockge", href: url("/apps/d") }, { text: "ntfy" }])] },
  ],
  action: { label: "Open the deployment", href: url("/apps/app_9xk2/deployments") },
  links: [{ label: "Deployment log", href: url("/apps/app_9xk2/deployments") }],
  footer: { ...footer, note: "Next recap in 30 days." },
};

const deployFailed: NotificationMailBody = {
  tone: "fail",
  status: "Failed",
  heading: "search-data failed at health check",
  blocks: [
    { kind: "reassure", strong: "Nothing is down.", text: "The previous version is still serving." },
    {
      kind: "callout",
      tone: "bad",
      title: "Meilisearch crashed on start",
      body: "Its database is version 1.13.3 and the new engine is 1.54.3, so it refuses to open the data. It restarted 5 times before Vardo gave up.",
      action: { label: "Meilisearch upgrade guide", href: "https://www.meilisearch.com/docs" },
    },
    { kind: "section", title: "Where the time went" },
    { kind: "phases", steps: [{ label: "Pull", value: 12, detail: "8s" }, { label: "Start", value: 4, detail: "3s" }, { label: "Health", value: 84, detail: "59s", failed: true }] },
    { kind: "section", title: "Last log lines" },
    { kind: "log", lines: [
      "meilisearch-1 | Starting Meilisearch",
      "meilisearch-1 | Error: Your database version (1.13.3) is incompatible with your current engine version (1.54.3).",
      "meilisearch-1 exited with code 1 (restarting)",
    ] },
    { kind: "facts", facts: [
      { label: "Project", value: "Shop · production", rich: [nameLink("Shop", url("/projects/shop")), " · production"] },
      { label: "Trigger", value: "Manual, by Alex Kim" },
      { label: "Ran for", value: "1m 14s" },
    ] },
  ],
  action: { label: "Open the deployment", href: url("/apps/app_srch/deployments") },
  links: [
    { label: "App logs", href: url("/apps/app_srch/logs") },
    { label: "Redeploy", href: url("/apps/app_srch") },
  ],
  footer,
};

const recap: NotificationMailBody = {
  tone: "info",
  status: "Recap",
  heading: "72-hour recap: immich",
  blocks: [
    { kind: "text", text: ["Vardo has a baseline for how ", nameLink("immich", url("/apps/immich")), " normally runs. If something changes outside a deploy, you'll get an email."] },
    { kind: "callout", tone: "warn", title: "immich-library isn't backed up", body: "212 GB with no backup yet.", action: { label: "Set up backups", href: url("/backups") } },
    { kind: "callout", tone: "warn", title: "Memory peaked near the limit", body: "1.88 of 2 GB on Oct 15, while indexing photos.", action: { label: "Adjust the limit", href: url("/apps/immich") } },
    { kind: "timeline", current: 1, steps: [{ label: "Deployed", date: "Oct 13" }, { label: "Baseline set", date: "Oct 16" }, { label: "First month", date: "Nov 12" }] },
    {
      kind: "tiles",
      tiles: [
        { label: "Deploys", value: "2", sub: "all succeeded" },
        { label: "Average build", value: "—", sub: "prebuilt image" },
        { label: "Uptime", value: "100", unit: "%", sub: "no restarts" },
        { label: "CPU", value: "4", unit: "%", sub: "peak 88%" },
        { label: "Memory", value: "0.9", unit: " GB", sub: "peak 1.88 of 2 GB", hot: true },
        { label: "Bandwidth", value: "3.4", unit: " GB", sub: "in · 610 MB out" },
      ],
    },
    { kind: "section", title: "Busiest hours" },
    { kind: "hours", values: [1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 4, 4, 2, 1, 1] },
    { kind: "section", title: "Storage" },
    { kind: "volumes", rows: [
      { name: "immich-library", size: "212 GB", change: "+9 GB", value: 212, flag: "no backups" },
      { name: "immich-postgres", size: "1.6 GB", change: "+80 MB", value: 1.6 },
      { name: "immich-model-cache", size: "640 MB", change: "no change", value: 0.64 },
    ], caption: "Bars compare this app's volumes. Change is since deploy." },
    { kind: "facts", facts: [
      { label: "Ports", value: "tcp/2283, tcp/3003", rich: [{ chip: "tcp/2283" }, { chip: "tcp/3003" }] },
      { label: "Processes", value: "node, python3, postgres, redis-server" },
      { label: "Backups", value: "immich-postgres nightly at 3:00, last ran Oct 16" },
    ] },
  ],
  action: { label: "Open immich", href: url("/apps/immich") },
  footer: { ...footer, instanceName: "Long House", note: "Next recap in 30 days." },
};

export const KIT_SAMPLES: { name: string; subject: string; body: NotificationMailBody }[] = [
  { name: "kit", subject: "node-a · Email kit", body: kit },
  { name: "kit-deploy-failed", subject: "node-a · ✗ search-data failed at health check · still serving the previous version", body: deployFailed },
  { name: "kit-recap", subject: "Long House · 72-hour recap: immich · library isn't backed up", body: recap },
];
