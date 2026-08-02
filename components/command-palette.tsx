"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import {
  FolderKanban,
  LayoutDashboard,
  Settings,
  Shield,
  Users,
  Activity,
  Archive,
  Server,
  Wrench,
  BarChart3,
  UserCircle,
  Mail,
  HardDrive,
  GitBranch,
  Blocks,
  ArrowUpCircle,
  ChevronLeft,
  RotateCcw,
  Rocket,
  ScrollText,
  Undo2,
} from "lucide-react";
import { AppIcon } from "@/components/app-status";
import { toast } from "@/lib/messenger";
import {
  byRelevance,
  fillApp,
  rankActions,
  rankResult,
  ID_SEP,
  type CommandActionDef,
  type CommandActionId,
} from "@/lib/ui/command-palette";

type CommandPaletteProps = {
  orgId: string | null;
};

const ACTION_ICON: Record<CommandActionId, typeof RotateCcw> = {
  restart: RotateCcw,
  deploy: Rocket,
  logs: ScrollText,
  rollback: Undo2,
};

const OPEN_EVENT = "vardo:open-command-palette";

/** Opens the command palette from outside it, e.g. the top nav's search hint. */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

type SearchableApp = {
  id: string;
  name: string;
  displayName: string;
  status: string;
  source: string;
  deployType: string;
  imageName: string | null;
  /** Compose parent, when this app is one of its services. */
  parentName: string | null;
  projectName: string | null;
  domains: string[];
};

type SearchableProject = {
  id: string;
  name: string;
  displayName: string;
};

/** An action holding at its confirm step. */
type PendingConfirm = { action: CommandActionDef; app: SearchableApp };

/**
 * Drains the deploy stream so the palette reports what the deploy did, not
 * that it dispatched one.
 */
async function runDeploy(orgId: string, app: SearchableApp) {
  const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Deploy failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ") && (event === "done" || event === "error")) {
        const data = JSON.parse(line.slice(6));
        if (event === "error") throw new Error(data.message ?? "Deploy failed");
        if (!data.success) throw new Error(data.error ?? "Deploy failed");
        return;
      }
    }
  }
  throw new Error("Deploy stream ended without a result");
}

export function CommandPalette({ orgId }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<SearchableApp[]>([]);
  const [projects, setProjects] = useState<SearchableProject[]>([]);
  const [orgEnvKeys, setOrgEnvKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Verb picked in step one; the list then picks the app. */
  const [pendingAction, setPendingAction] = useState<CommandActionDef | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const [running, setRunning] = useState(false);
  const router = useRouter();

  const rankedApps = useMemo(
    () =>
      byRelevance(apps, search, (a) => [
        a.displayName,
        [a.name, a.parentName, a.projectName, a.imageName, ...a.domains].filter(
          (k): k is string => !!k,
        ),
      ]),
    [apps, search],
  );
  const rankedProjects = useMemo(
    () => byRelevance(projects, search, (p) => [p.displayName, [p.name]]),
    [projects, search],
  );
  const rankedActions = useMemo(() => rankActions(search), [search]);

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      setSearch("");
      setPendingAction(null);
      command();
    },
    []
  );

  const execute = useCallback(
    async ({ action, app }: PendingConfirm) => {
      if (!orgId) return;
      const base = `/api/v1/organizations/${orgId}/apps/${app.id}`;
      setRunning(true);
      try {
        if (action.id === "restart") {
          const res = await fetch(`${base}/restart`, { method: "POST" });
          const body = await res.json();
          if (!res.ok || !body.success) throw new Error(body.error ?? "Restart failed");
          toast.success(`Restarted ${app.displayName}`);
          router.refresh();
        } else if (action.id === "rollback") {
          const res = await fetch(`${base}/instant-rollback`, { method: "POST" });
          const body = await res.json();
          if (!res.ok || body.success === false) throw new Error(body.error ?? "Rollback failed");
          toast.success(`Rolled ${app.displayName} back to the previous release`);
          router.refresh();
        } else if (action.id === "deploy") {
          // Land on the app first, so the run has somewhere to be watched.
          router.push(`/apps/${app.name}/deployments`);
          toast.info(`Deploying ${app.displayName}…`);
          await runDeploy(orgId, app);
          toast.success(`Deployed ${app.displayName}`);
          router.refresh();
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `${action.verb} failed`);
      } finally {
        setRunning(false);
        setConfirming(null);
      }
    },
    [orgId, router],
  );

  /** Step two: the app is chosen, so navigate or ask before firing. */
  const chooseApp = useCallback(
    (app: SearchableApp) => {
      const action = pendingAction;
      if (!action) {
        runCommand(() => router.push(`/apps/${app.name}`));
        return;
      }
      if (action.id === "logs") {
        runCommand(() => router.push(`/apps/${app.name}/logs`));
        return;
      }
      setOpen(false);
      setSearch("");
      setPendingAction(null);
      setConfirming({ action, app });
    },
    [pendingAction, router, runCommand],
  );

  // Global keyboard listener for Cmd/Ctrl+K, plus an event for external triggers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
    };
    const handleOpenEvent = () => setOpen(true);

    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(OPEN_EVENT, handleOpenEvent);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(OPEN_EVENT, handleOpenEvent);
    };
  }, [open]);

  // Fetch searchable data when opened
  useEffect(() => {
    if (!open || loaded || !orgId) return;

    fetch(`/api/v1/organizations/${orgId}/search`)
      .then((r) => r.json())
      .then((data) => {
        setApps(data.apps || []);
        setProjects(data.projects || []);
        setOrgEnvKeys(data.orgEnvKeys || []);
        setLoaded(true);
      })
      .catch(() => {});
  }, [open, loaded, orgId]);

  // Invalidate cache when dialog closes
  useEffect(() => {
    if (!open) {
      // Reset after a delay so data is fresh next open
      const timer = setTimeout(() => setLoaded(false), 30000);
      return () => clearTimeout(timer);
    }
  }, [open]);

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for commands and navigate</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[550px]" showCloseButton={false}>
        <Command filter={rankResult} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            placeholder={pendingAction ? pendingAction.prompt : "Search apps, projects, pages..."}
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !search && pendingAction) {
                e.preventDefault();
                setPendingAction(null);
              }
            }}
            autoFocus
          />

          {pendingAction && (
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="flex w-full items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
              {pendingAction.verb} — pick an app
            </button>
          )}

          <CommandList className="max-h-[400px]">
            <CommandEmpty>No results found.</CommandEmpty>

            {/* Actions — matched on the verb, with the app chosen next. */}
            {!pendingAction && rankedActions.length > 0 && (
              <CommandGroup heading="Actions">
                {rankedActions.map((action) => {
                  const Icon = ACTION_ICON[action.id];
                  return (
                    <CommandItem
                      key={action.id}
                      value={`${action.verb}${ID_SEP}action-${action.id}`}
                      keywords={action.keywords}
                      onSelect={() => {
                        setPendingAction(action);
                        setSearch("");
                      }}
                      className="gap-2"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span>{action.verb} an app</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {/* Apps */}
            {apps.length > 0 && (
              <CommandGroup heading={pendingAction ? "Pick an app" : "Apps"}>
                {rankedApps.map((app) => (
                  <CommandItem
                    key={app.id}
                    // Name is the value; everything else is a keyword. Folding
                    // them into one string made cmdk score the blob, which put
                    // plex sixth behind plextraktsync on a search for "plex".
                    value={`${app.displayName}${ID_SEP}${app.id}`}
                    keywords={[
                      app.name,
                      app.parentName,
                      app.projectName,
                      app.imageName,
                      ...app.domains,
                    ].filter((k): k is string => !!k)}
                    onSelect={() => chooseApp(app)}
                    className="gap-2"
                  >
                    <AppIcon app={app} size="sm" />
                    <span>
                      {pendingAction ? fillApp(`${pendingAction.verb} {app}`, app.displayName) : app.displayName}
                    </span>
                    {/* Three stacks each have a service called Redis; the parent
                        is what tells those rows apart. */}
                    {(app.parentName || app.projectName) && (
                      <span className="text-xs text-muted-foreground ml-auto truncate">
                        {app.parentName ?? app.projectName}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Projects */}
            {!pendingAction && projects.length > 0 && (
              <CommandGroup heading="Projects">
                {rankedProjects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${project.displayName}${ID_SEP}${project.id}`}
                    keywords={[project.name]}
                    onSelect={() => runCommand(() => router.push(`/projects/${project.name}`))}
                    className="gap-2"
                  >
                    <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                    <span>{project.displayName}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Org environment variables */}
            {!pendingAction && orgEnvKeys.length > 0 && (
              <CommandGroup heading="Shared Variables">
                {orgEnvKeys.map((key) => (
                  <CommandItem
                    key={key}
                    value={key}
                    keywords={["env", "variable"]}
                    onSelect={() => runCommand(() => router.push("/settings/variables"))}
                    className="gap-2"
                  >
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{key}</code>
                    <span className="text-xs text-muted-foreground ml-auto">Org variable</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!pendingAction && <CommandSeparator />}

            {/* Pages */}
            {!pendingAction && (
            <CommandGroup heading="Pages">
              <CommandItem
                value="Dashboard Projects Home"
                onSelect={() => runCommand(() => router.push("/projects"))}
                className="gap-2"
              >
                <LayoutDashboard className="size-4" />
                <span>Dashboard</span>
              </CommandItem>
              <CommandItem
                value="Metrics Monitoring"
                onSelect={() => runCommand(() => router.push("/metrics"))}
                className="gap-2"
              >
                <BarChart3 className="size-4" />
                <span>Metrics</span>
              </CommandItem>
              <CommandItem
                value="Backups"
                onSelect={() => runCommand(() => router.push("/backups"))}
                className="gap-2"
              >
                <Archive className="size-4" />
                <span>Backups</span>
              </CommandItem>
              <CommandItem
                value="Activity Log"
                onSelect={() => runCommand(() => router.push("/activity"))}
                className="gap-2"
              >
                <Activity className="size-4" />
                <span>Activity</span>
              </CommandItem>
              <CommandItem
                value="Updates Image updates"
                onSelect={() => runCommand(() => router.push("/updates"))}
                className="gap-2"
              >
                <ArrowUpCircle className="size-4" />
                <span>Updates</span>
              </CommandItem>
              <CommandItem
                value="Team Members"
                onSelect={() => runCommand(() => router.push("/settings/team"))}
                className="gap-2"
              >
                <Users className="size-4" />
                <span>Team</span>
              </CommandItem>
              <CommandItem
                value="Settings Organization"
                onSelect={() => runCommand(() => router.push("/settings"))}
                className="gap-2"
              >
                <Settings className="size-4" />
                <span>Settings</span>
              </CommandItem>
              <CommandItem
                value="Profile Account Settings"
                onSelect={() => runCommand(() => router.push("/user/settings/profile"))}
                className="gap-2"
              >
                <UserCircle className="size-4" />
                <span>Account settings</span>
              </CommandItem>
            </CommandGroup>
            )}

            {/* Admin */}
            {!pendingAction && (
            <CommandGroup heading="Admin">
              <CommandItem
                value="Admin Overview"
                onSelect={() => runCommand(() => router.push("/admin"))}
                className="gap-2"
              >
                <Shield className="size-4" />
                <span>Admin</span>
              </CommandItem>
              <CommandItem
                value="Admin System Infrastructure Health"
                onSelect={() => runCommand(() => router.push("/admin"))}
                className="gap-2"
              >
                <Server className="size-4" />
                <span>System Health</span>
              </CommandItem>
              <CommandItem
                value="Admin Maintenance Docker Cleanup"
                onSelect={() => runCommand(() => router.push("/admin/maintenance"))}
                className="gap-2"
              >
                <Wrench className="size-4" />
                <span>Maintenance</span>
              </CommandItem>
              <CommandItem
                value="Admin Settings System Email SMTP"
                onSelect={() => runCommand(() => router.push("/admin/settings/email"))}
                className="gap-2"
              >
                <Mail className="size-4" />
                <span>Admin settings: Email</span>
              </CommandItem>
              <CommandItem
                value="Admin Settings Backup Storage S3 R2"
                onSelect={() => runCommand(() => router.push("/admin/settings/backup"))}
                className="gap-2"
              >
                <HardDrive className="size-4" />
                <span>Admin settings: Backup</span>
              </CommandItem>
              <CommandItem
                value="Admin Settings GitHub App Integration"
                onSelect={() => runCommand(() => router.push("/admin/settings/github"))}
                className="gap-2"
              >
                <GitBranch className="size-4" />
                <span>Admin settings: GitHub App</span>
              </CommandItem>
              <CommandItem
                value="Admin Settings Services Metrics Logs"
                onSelect={() => runCommand(() => router.push("/admin/settings/services"))}
                className="gap-2"
              >
                <Blocks className="size-4" />
                <span>Admin settings: Services</span>
              </CommandItem>
            </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>

    {confirming?.action.confirm && (
      <ConfirmDeleteDialog
        open
        onOpenChange={(next) => !next && !running && setConfirming(null)}
        title={fillApp(confirming.action.confirm.title, confirming.app.displayName)}
        description={confirming.action.confirm.description}
        confirmLabel={confirming.action.confirm.label}
        loadingLabel={confirming.action.confirm.loadingLabel}
        variant={confirming.action.confirm.variant}
        loading={running}
        onConfirm={() => execute(confirming)}
      />
    )}
    </>
  );
}
