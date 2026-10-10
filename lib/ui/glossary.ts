// Plain-language explanations for the console's own terms. One source for every <Term>.

import { BACKUP_NEVER_RAN_DETAIL, type AppCondition, type ConditionKind } from "@/lib/docker/conditions";
import type { ProblemGroup } from "@/lib/ui/conditions";
import type { StatusMarkState } from "@/lib/ui/status-colors";

export const DOCS_URL = "https://vardo.run/docs";

export type GlossaryEntry = {
  /** The words as the UI shows them. */
  term: string;
  /** A friendlier name, when the UI's is terse. */
  label?: string;
  /** One or two short sentences: what it means and what to do. */
  what: string;
  /** Anchor on the docs glossary page. */
  docs?: string;
  /** Other UI wordings for the same thing. */
  aliases?: string[];
};

const entries = {
  // App statuses
  running: {
    term: "Running",
    what: "The app's container is up and Vardo sees nothing wrong with it.",
  },
  deploying: {
    term: "Deploying",
    what: "Vardo is building and starting a new version. Any previous version keeps serving until the new one is healthy.",
  },
  stopped: {
    term: "Stopped",
    what: "The app isn't running. Start or deploy it to bring it back.",
    docs: "stopped",
  },
  parked: {
    term: "Parked",
    label: "Stopped by you",
    what: "Someone stopped this app on purpose, so Vardo leaves it down and skips its alerts and backup checks. Start or deploy it to bring it back.",
    docs: "parked",
    aliases: ["Stopped by you"],
  },
  missing: {
    term: "No container",
    what: "Vardo expects this app to be running, but there's nothing on the server for it. Deploying recreates it.",
    docs: "no-container",
  },
  crashed: {
    term: "Crashed",
    what: "The container stopped on its own with an error. The logs usually say why. Restart it, or deploy a fix.",
    docs: "crashed",
  },
  "crash-looping": {
    term: "Crash looping",
    what: "The container keeps starting and dying again. Check the logs for the error right before each exit.",
    docs: "crash-looping",
  },
  "self-heal-exhausted": {
    term: "Restarts exhausted",
    label: "Self-heal gave up",
    what: "Vardo restarts crashed apps on its own, but this one kept failing, so it stopped trying. Fix the cause in the logs, then restart.",
    docs: "restarts-exhausted",
    aliases: ["Self-heal gave up"],
  },
  unhealthy: {
    term: "Health check failing",
    label: "Unhealthy",
    what: "The app is running, but its own health check says it isn't working. The logs usually show why.",
    docs: "health-check-failing",
    aliases: ["Unhealthy", "Failing health checks"],
  },
  failed: {
    term: "Failed",
    what: "The last deploy failed or the container crashed. The details say which, with a fix to try.",
    docs: "failed",
    aliases: ["Failed or crashed"],
  },
  "needs-attention": {
    term: "Needs attention",
    what: "The app is up, but something is off, like a failing health check or an overdue backup. Open it to see what.",
    aliases: ["Need attention"],
  },
  "deploy-failed": {
    term: "Deploy failed",
    what: "The new version didn't build or didn't pass its health check. If an older version was running, it still is. The deploy log says why.",
    docs: "deploy-failed",
  },
  "deploy-needed": {
    term: "Deploy needed",
    what: "Settings changed since the last deploy. They take effect on the next deploy. A restart doesn't apply them.",
    docs: "deploy-needed",
  },

  // Problem groups and conditions
  "vardo-stack": {
    term: "Vardo",
    label: "Vardo's own services",
    what: "The services Vardo itself runs on, like its database and proxy. While these are down, deploys and alerts may not work.",
  },
  anomaly: {
    term: "Unusual activity",
    label: "Anomaly",
    what: "Far more CPU, traffic, disk writes or processes than this app's normal for the time of day. Check logs, recent deploys and processes.",
    docs: "unusual-activity",
    aliases: ["Anomaly"],
  },
  "unreachable-domain": {
    term: "Unreachable domains",
    what: "Vardo's last check couldn't reach these domains. Usually DNS points somewhere else, or the app isn't answering.",
    docs: "unreachable-domains",
    aliases: ["Unreachable domain"],
  },
  "memory-pressure": {
    term: "Memory pressure",
    what: "The app is close to its memory limit. At the limit the container is killed and restarted. Raise the limit or find what's using it.",
    docs: "memory-pressure",
  },
  "errors-up": {
    term: "Errors up",
    what: "The app is logging errors much faster than it usually does. The logs show which ones.",
    docs: "errors-up",
  },
  backups: {
    term: "Backups",
    label: "Backup problems",
    what: "Data that doesn't have a recent good backup. Back up now, or check the job's schedule and storage.",
    docs: "backup-problems",
  },
  "security-findings": {
    term: "Security findings",
    what: "Vardo checked the app's public site and found something to fix, like an exposed file, a missing security header or an open port.",
    docs: "security-findings",
  },
  certificate: {
    term: "Certificates",
    label: "HTTPS certificates",
    what: "Vardo gets and renews HTTPS certificates on its own. One near expiry means renewal is failing, usually because DNS doesn't point here.",
    docs: "certificates",
    aliases: ["Certificate"],
  },
  "cert-expiring": {
    term: "Certificate expiring",
    what: "The HTTPS certificate expires within three weeks and hasn't renewed. Check that the domain's DNS points at this server.",
    docs: "certificates",
    aliases: ["Cert expiring"],
  },
  "cert-expired": {
    term: "Certificate expired",
    what: "Browsers now warn visitors the site isn't secure. Renewal failed, usually because the domain's DNS doesn't point at this server.",
    docs: "certificates",
    aliases: ["Cert expired"],
  },

  // Backups
  "backup-failed": {
    term: "Backup failed",
    what: "The last backup run didn't finish, so there's no new copy. The run log says why. Fix it and run it again.",
    docs: "backup-failed",
  },
  "backup-overdue": {
    term: "Overdue",
    label: "Backup overdue",
    what: "It's been too long since the last successful backup. Check that the job is on and its storage still works.",
    docs: "backup-overdue",
    aliases: ["Backup overdue"],
  },
  "backup-never": {
    term: "Never backed up",
    what: "A backup job covers this app, but it hasn't finished a run yet. Run it now to get a first copy.",
    docs: "never-backed-up",
  },
  "backup-uncovered": {
    term: "Not covered by a backup job",
    what: "This app stores data, but no backup job includes it. Add it to a job so a bad deploy or a dead disk can't lose it.",
    docs: "not-covered",
    aliases: ["No backup"],
  },
  "backup-paused": {
    term: "Paused",
    label: "Job paused",
    what: "This job is turned off and won't run on its schedule. Turn it back on to resume backups.",
    docs: "backup-paused",
  },
  "cron-paused": {
    term: "Paused",
    label: "Cron job paused",
    what: "This cron job won't run on its schedule until you turn it back on. Running it by hand still works.",
  },
  "backup-skipped": {
    term: "Skipped",
    what: "Vardo couldn't capture this source, usually because it's a bind mount, not a volume. Not a failure, but that data isn't in this backup.",
    docs: "bind-mount-vs-volume",
  },
  "restore-drill": {
    term: "Restore drill",
    label: "Restore test",
    what: "Vardo restores a backup into a throwaway container and checks the data loads. A passed drill means the backup works, not only that it exists.",
    docs: "restore-drill",
    aliases: ["Restore test", "Restore verified", "Restore test failed", "Not verified yet"],
  },
  retention: {
    term: "Retention",
    what: "How many old backups to keep, like the last 7 daily and 4 weekly. Older ones are deleted to save space.",
    docs: "retention",
  },
  "bind-mount": {
    term: "Bind mount",
    what: "A folder on the server mapped into the container. Vardo can't back these up, so keep data you need in a volume.",
    docs: "bind-mount-vs-volume",
  },
  volume: {
    term: "Volume",
    what: "Storage Docker manages for the container. Data in it survives restarts and deploys, and Vardo can back it up.",
    docs: "bind-mount-vs-volume",
  },

  // Deploys
  "phase-clone": {
    term: "Clone",
    what: "Vardo downloads your code from its Git repository.",
    docs: "deploy-phases",
  },
  "phase-build": {
    term: "Build",
    what: "Vardo turns your code into a container image, using your Dockerfile or a buildpack.",
    docs: "deploy-phases",
  },
  "phase-start": {
    term: "Deploy",
    label: "Start",
    what: "Vardo starts the new version next to the one that's live. Visitors still reach the old one.",
    docs: "deploy-phases",
    aliases: ["Start"],
  },
  "health-check": {
    term: "Health check",
    what: "A test Vardo runs against the new version before it gets traffic. If it fails, the old version keeps running.",
    docs: "health-check",
    aliases: ["Health"],
  },
  rollback: {
    term: "Rollback",
    what: "Going back to the previous version. Vardo does it on its own when a deploy fails its health check, and you can do it by hand.",
    docs: "rollback",
  },
  "rolled-back": {
    term: "Rolled back",
    what: "This version was replaced by an earlier one, either by hand or because it failed its health check.",
    docs: "rollback",
  },
  "instant-rollback": {
    term: "Instant rollback",
    what: "The previous version is still on the server in the standby slot, so going back takes seconds, not a rebuild.",
    docs: "blue-green-slots",
  },
  superseded: {
    term: "Superseded",
    what: "This deploy worked, but a newer one has replaced it.",
  },
  "blue-green": {
    term: "Blue/green slots",
    what: "Each app has two slots. A new version starts in the idle one while the live one keeps serving, then traffic switches over.",
    docs: "blue-green-slots",
    aliases: ["Slot", "Standby slot"],
  },
  cutover: {
    term: "Cutover",
    what: "The moment traffic moves from the old version to the new one, once the new one is healthy. Visitors shouldn't notice.",
    docs: "cutover",
  },

  // Resources
  "memory-limit": {
    term: "Memory limit",
    what: "The most memory the app can use. Over it, the container is killed and restarted, so set it above the app's normal peak.",
    docs: "memory-limit",
  },
  "no-memory-limit": {
    term: "No memory limit",
    what: "Nothing caps this app's memory, so a leak can starve every other app on the server. Set a limit or use Auto.",
    docs: "memory-limit",
    aliases: ["Without a memory limit"],
  },
  "cpu-limit": {
    term: "CPU limit",
    what: "The most processor time the app can use, in cores. Over the limit it slows down instead of crashing.",
    docs: "cpu-limit",
  },
  "memory-profile": {
    term: "Memory profile",
    what: "How Vardo sets the app's memory limit: Fixed, Burstable or Auto.",
    docs: "memory-profiles",
    aliases: ["Default memory profile"],
  },
  "profile-fixed": {
    term: "Fixed",
    what: "A hard memory limit that changes only when you change it.",
    docs: "memory-profiles",
  },
  "profile-burstable": {
    term: "Burstable",
    what: "A guaranteed amount of memory plus a higher ceiling the app can use when the server has room.",
    docs: "memory-profiles",
  },
  "profile-auto": {
    term: "Auto",
    what: "Vardo sets the memory limit for you: up after the app runs out, down after a long quiet stretch.",
    docs: "memory-profiles",
  },

  // Updates and security
  "image-update": {
    term: "Image update",
    what: "A newer version of an image this app uses is out. Review what changed, then apply it to redeploy on the new version.",
    docs: "image-updates",
    aliases: ["Image updates"],
  },
  "severity-critical": {
    term: "Critical",
    what: "Fix this now. Something sensitive is open to anyone, like a secrets file visitors can download.",
    docs: "severity",
  },
  "severity-warning": {
    term: "Warning",
    what: "Worth fixing soon, but not an emergency, like a missing security header.",
    docs: "severity",
  },
  "severity-info": {
    term: "Info",
    what: "Good to know. No action needed unless it surprises you.",
    docs: "severity",
  },

  // Linked instances and self-update
  "linked-instances": {
    term: "Linked instances",
    what: "Other Vardo servers you run. Linking them lets one try an update before the rest take it.",
    docs: "canary-and-follower",
  },
  canary: {
    term: "Canary",
    what: "This instance takes Vardo updates first. Instances that follow it wait until it has run the new version without trouble.",
    docs: "canary-and-follower",
  },
  follower: {
    term: "Follower",
    what: "This instance updates only after its canary has run the new version healthy for a set time, or once you approve it.",
    docs: "canary-and-follower",
  },
  mesh: {
    term: "Mesh",
    what: "A private, encrypted network that links your Vardo servers so they can reach each other.",
    docs: "mesh",
  },
  "update-policy": {
    term: "Update policy",
    what: "How this instance handles updates to Vardo itself: Off, Notify or Auto.",
    docs: "update-policy",
  },
  "update-off": {
    term: "Off",
    what: "No update notices. You can still update by hand.",
    docs: "update-policy",
  },
  "update-notify": {
    term: "Notify",
    what: "Vardo emails admins when an update is out. You choose when to apply it.",
    docs: "update-policy",
  },
  "update-auto": {
    term: "Auto",
    what: "Vardo updates itself inside the maintenance window, after its checks pass and a database dump is taken.",
    docs: "update-policy",
  },

  // Notifications
  "delivery-immediate": {
    term: "Immediate",
    what: "Sent as soon as it happens. Used for problems someone should look at now.",
    docs: "notification-delivery",
  },
  "delivery-batch": {
    term: "Batch",
    what: "One email per run, sent only when something is new or wrong, like a backup round with a failure in it.",
    docs: "notification-delivery",
  },
  "delivery-digest": {
    term: "Digest",
    what: "Routine news, like successful deploys, rolled into a regular summary email instead of one email each.",
    docs: "notification-delivery",
    aliases: ["Weekly digest", "Health summary"],
  },

  // Encryption
  "key-fingerprint": {
    term: "Fingerprint",
    what: "A short label that identifies a key without revealing it. If two keys have the same fingerprint, they're the same key.",
  },
  "backup-encrypted": {
    term: "Encrypted",
    what: "Encrypted with this server's recovery key. Restoring on another server needs that key.",
  },

  // Organizations and services
  "trusted-org": {
    term: "Trusted",
    label: "Trusted organization",
    what: "Vardo skips its compose safety checks for this org, allowing bind mounts and links to other apps' routes. Only for people you'd trust on the server.",
    docs: "trusted-organization",
    aliases: ["Trusted organization", "Trusted environment"],
  },
  "service-kind": {
    term: "Service kind",
    label: "Kind",
    what: "What a service does: web, database, cache, worker or other. Vardo guesses from the image and nests databases, caches and workers under their app.",
    docs: "service-kind",
    aliases: ["Kind"],
  },
} satisfies Record<string, GlossaryEntry>;

export type GlossaryId = keyof typeof entries;

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = entries;

export const GLOSSARY_IDS = Object.keys(entries) as GlossaryId[];

export function isGlossaryId(value: string): value is GlossaryId {
  return Object.hasOwn(entries, value);
}

/** The public docs link for an entry, or null when it has none. */
export function glossaryHref(id: GlossaryId): string | null {
  const slug = GLOSSARY[id].docs;
  return slug ? `${DOCS_URL}/glossary#${slug}` : null;
}

/** apps.status values. */
export const APP_STATUS_TERM: Record<"active" | "stopped" | "error" | "deploying" | "missing", GlossaryId> = {
  active: "running",
  stopped: "stopped",
  error: "crashed",
  deploying: "deploying",
  missing: "missing",
};

export const CONDITION_TERM: Record<ConditionKind, GlossaryId> = {
  "crash-looping": "crash-looping",
  unhealthy: "unhealthy",
  "self-heal-exhausted": "self-heal-exhausted",
  "memory-pressure": "memory-pressure",
  "security-findings": "security-findings",
  "backup-missing": "backup-uncovered",
  "backup-stale": "backup-overdue",
  "cert-expiring": "cert-expiring",
  "cert-expired": "cert-expired",
};

/** The entry for one condition. A backup job that never ran reads as never backed up. */
export function conditionTerm(c: Pick<AppCondition, "kind" | "detail">): GlossaryId {
  if (c.kind === "backup-stale" && c.detail === BACKUP_NEVER_RAN_DETAIL) return "backup-never";
  return CONDITION_TERM[c.kind];
}

export const PROBLEM_GROUP_TERM: Record<ProblemGroup, GlossaryId> = {
  vardo: "vardo-stack",
  crash: "crash-looping",
  failed: "failed",
  anomaly: "anomaly",
  missing: "missing",
  domains: "unreachable-domain",
  health: "unhealthy",
  memory: "memory-pressure",
  errors: "errors-up",
  backups: "backups",
  certs: "certificate",
  security: "security-findings",
  config: "deploy-needed",
};

export const STATUS_MARK_TERM: Record<StatusMarkState["label"], GlossaryId> = {
  Running: "running",
  Deploying: "deploying",
  "Needs attention": "needs-attention",
  Failed: "failed",
  Stopped: "stopped",
};

/** An attention group's key: a problem group or an informational row key. */
export function attentionGroupTerm(key: string): GlossaryId | null {
  if (Object.hasOwn(PROBLEM_GROUP_TERM, key)) return PROBLEM_GROUP_TERM[key as ProblemGroup];
  if (key === "image-updates") return "image-update";
  return isGlossaryId(key) ? key : null;
}

/** Problem titles and status words the glossary explains. Ambiguous words like "Auto" are left out. */
const BY_TEXT = new Map<string, GlossaryId>();
const AMBIGUOUS = new Set(["auto", "off", "paused", "skipped", "deploy", "vardo", "backups", "certificates"]);
for (const id of GLOSSARY_IDS) {
  const e: GlossaryEntry = GLOSSARY[id];
  for (const text of [e.term, ...(e.aliases ?? [])]) {
    const key = text.toLowerCase();
    if (!AMBIGUOUS.has(key) && !BY_TEXT.has(key)) BY_TEXT.set(key, id);
  }
}

/** The entry that explains a problem title or status word, such as "No container" or "Memory at 92%". */
export function termForText(text: string): GlossaryId | null {
  const key = text.trim().toLowerCase();
  if (/^memory at \d+%$/.test(key)) return "memory-pressure";
  return BY_TEXT.get(key) ?? null;
}
