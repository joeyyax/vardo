"use client";

import { useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from "react";
import Link from "next/link";
import { runDeploy } from "@/lib/ui/run-deploy";
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
  Clock,
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
import { appHref, projectHref } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";
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
  teamsEnabled?: boolean;
  activityEnabled?: boolean;
  cronEnabled?: boolean;
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


/** How a link item was chosen: Enter, a plain click, or a click that opens a new tab. */
type Via = "key" | "click" | "new-tab";

/** A result that is a real link, so Cmd/Ctrl-click and middle-click open a new tab. */
function NavItem({
  href,
  value,
  keywords,
  className,
  onNavigate,
  children,
}: {
  href: string;
  value: string;
  keywords?: string[];
  className?: string;
  onNavigate: (href: string, via: Via) => void;
  children: ReactNode;
}) {
  const via = useRef<Via>("key");
  return (
    <CommandItem
      asChild
      value={value}
      keywords={keywords}
      className={cn("cursor-pointer", className)}
      onSelect={() => {
        const how = via.current;
        via.current = "key";
        onNavigate(href, how);
      }}
    >
      <Link
        href={href}
        onClick={(e) => {
          via.current = e.metaKey || e.ctrlKey || e.shiftKey ? "new-tab" : "click";
        }}
      >
        {children}
      </Link>
    </CommandItem>
  );
}

export function CommandPalette({ orgId, teamsEnabled = true, activityEnabled = true, cronEnabled = true }: CommandPaletteProps) {
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
          // Land on the app first so the run can be watched.
          router.push(appHref(app.name, "deployments"));
          toast.info(`Deploying ${app.displayName}…`);
          await runDeploy(orgId, app.id);
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

  // A click lets the link navigate; Enter pushes; a new-tab click leaves the palette open.
  const navigate = useCallback(
    (href: string, via: Via) => {
      if (via === "new-tab") return;
      runCommand(() => {
        if (via === "key") router.push(href);
      });
    },
    [router, runCommand],
  );

  /** Step two: an action's app is chosen, so ask before firing. */
  const chooseApp = useCallback(
    (app: SearchableApp) => {
      const action = pendingAction;
      if (!action) return;
      setOpen(false);
      setSearch("");
      setPendingAction(null);
      setConfirming({ action, app });
    },
    [pendingAction],
  );

  // Cmd/Ctrl+K, plus an event for external triggers.
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
      const timer = setTimeout(() => setLoaded(false), 30000);
      return () => clearTimeout(timer);
    }
  }, [open]);

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
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

            {/* Actions */}
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
                {rankedApps.map((app) => {
                  const keywords = [app.name, app.parentName, app.projectName, app.imageName, ...app.domains].filter(
                    (k): k is string => !!k,
                  );
                  const body = (
                    <>
                      <AppIcon app={app} size="sm" />
                      <span>
                        {pendingAction ? fillApp(`${pendingAction.verb} {app}`, app.displayName) : app.displayName}
                      </span>
                      {/* The parent tells same-named services apart. */}
                      {(app.parentName || app.projectName) && (
                        <span className="text-xs text-muted-foreground ml-auto truncate">
                          {app.parentName ?? app.projectName}
                        </span>
                      )}
                    </>
                  );
                  // Name is the value and the rest are keywords, so cmdk ranks exact names first.
                  const value = `${app.displayName}${ID_SEP}${app.id}`;
                  const href = !pendingAction ? appHref(app.name) : pendingAction.id === "logs" ? appHref(app.name, "logs") : null;
                  return href ? (
                    <NavItem key={app.id} href={href} value={value} keywords={keywords} onNavigate={navigate} className="gap-2">
                      {body}
                    </NavItem>
                  ) : (
                    <CommandItem key={app.id} value={value} keywords={keywords} onSelect={() => chooseApp(app)} className="gap-2">
                      {body}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {/* Projects */}
            {!pendingAction && projects.length > 0 && (
              <CommandGroup heading="Projects">
                {rankedProjects.map((project) => (
                  <NavItem
                    key={project.id}
                    href={projectHref(project.name)}
                    value={`${project.displayName}${ID_SEP}${project.id}`}
                    keywords={[project.name]}
                    onNavigate={navigate}
                    className="gap-2"
                  >
                    <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                    <span>{project.displayName}</span>
                  </NavItem>
                ))}
              </CommandGroup>
            )}

            {/* Org environment variables */}
            {!pendingAction && orgEnvKeys.length > 0 && (
              <CommandGroup heading="Shared variables">
                {orgEnvKeys.map((key) => (
                  <NavItem
                    key={key}
                    href="/settings/variables"
                    value={key}
                    keywords={["env", "variable"]}
                    onNavigate={navigate}
                    className="gap-2"
                  >
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{key}</code>
                    <span className="text-xs text-muted-foreground ml-auto">Organization variable</span>
                  </NavItem>
                ))}
              </CommandGroup>
            )}

            {!pendingAction && <CommandSeparator />}

            {/* Pages */}
            {!pendingAction && (
            <CommandGroup heading="Pages">
              <NavItem
                href="/projects"
                value="Dashboard Projects Home"
                onNavigate={navigate}
                className="gap-2"
              >
                <LayoutDashboard className="size-4" />
                <span>Dashboard</span>
              </NavItem>
              <NavItem
                href="/metrics"
                value="Metrics Monitoring"
                onNavigate={navigate}
                className="gap-2"
              >
                <BarChart3 className="size-4" />
                <span>Metrics</span>
              </NavItem>
              <NavItem
                href="/backups"
                value="Backups"
                onNavigate={navigate}
                className="gap-2"
              >
                <Archive className="size-4" />
                <span>Backups</span>
              </NavItem>
              {cronEnabled && (
                <NavItem
                  href="/cron"
                  value="Cron Scheduled Jobs"
                  onNavigate={navigate}
                  className="gap-2"
                >
                  <Clock className="size-4" />
                  <span>Cron</span>
                </NavItem>
              )}
              {activityEnabled && (
                <NavItem
                  href="/activity"
                  value="Activity Log"
                  onNavigate={navigate}
                  className="gap-2"
                >
                  <Activity className="size-4" />
                  <span>Activity</span>
                </NavItem>
              )}
              <NavItem
                href="/updates"
                value="Updates Image updates"
                onNavigate={navigate}
                className="gap-2"
              >
                <ArrowUpCircle className="size-4" />
                <span>Updates</span>
              </NavItem>
              {teamsEnabled && (
                <NavItem
                  href="/settings/team"
                  value="Team Members"
                  onNavigate={navigate}
                  className="gap-2"
                >
                  <Users className="size-4" />
                  <span>Team</span>
                </NavItem>
              )}
              <NavItem
                href="/settings"
                value="Settings Organization"
                onNavigate={navigate}
                className="gap-2"
              >
                <Settings className="size-4" />
                <span>Settings</span>
              </NavItem>
              <NavItem
                href="/user/settings/profile"
                value="Profile Account Settings"
                onNavigate={navigate}
                className="gap-2"
              >
                <UserCircle className="size-4" />
                <span>Account settings</span>
              </NavItem>
            </CommandGroup>
            )}

            {/* Admin */}
            {!pendingAction && (
            <CommandGroup heading="Admin">
              <NavItem
                href="/admin"
                value="Admin Overview"
                onNavigate={navigate}
                className="gap-2"
              >
                <Shield className="size-4" />
                <span>Admin</span>
              </NavItem>
              <NavItem
                href="/admin"
                value="Admin System Infrastructure Health"
                onNavigate={navigate}
                className="gap-2"
              >
                <Server className="size-4" />
                <span>System health</span>
              </NavItem>
              <NavItem
                href="/admin/maintenance"
                value="Admin Maintenance Docker Cleanup"
                onNavigate={navigate}
                className="gap-2"
              >
                <Wrench className="size-4" />
                <span>Maintenance</span>
              </NavItem>
              <NavItem
                href="/admin/settings/email"
                value="Admin Settings System Email SMTP"
                onNavigate={navigate}
                className="gap-2"
              >
                <Mail className="size-4" />
                <span>Admin settings: Email</span>
              </NavItem>
              <NavItem
                href="/admin/settings/backup"
                value="Admin Settings Backup Storage S3 R2"
                onNavigate={navigate}
                className="gap-2"
              >
                <HardDrive className="size-4" />
                <span>Admin settings: Backup</span>
              </NavItem>
              <NavItem
                href="/admin/settings/github"
                value="Admin Settings GitHub App Integration"
                onNavigate={navigate}
                className="gap-2"
              >
                <GitBranch className="size-4" />
                <span>Admin settings: GitHub App</span>
              </NavItem>
              <NavItem
                href="/admin/settings/services"
                value="Admin Settings Services Metrics Logs"
                onNavigate={navigate}
                className="gap-2"
              >
                <Blocks className="size-4" />
                <span>Admin settings: Services</span>
              </NavItem>
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
