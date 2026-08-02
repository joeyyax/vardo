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
} from "lucide-react";
import { AppIcon } from "@/components/app-status";

type CommandPaletteProps = {
  orgId: string | null;
  teamsEnabled?: boolean;
  activityEnabled?: boolean;
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
  projectName: string | null;
  domains: string[];
};

type SearchableProject = {
  id: string;
  name: string;
  displayName: string;
};

/** cmdk keys items by lowercased value, so two apps named Gitea and gitea collide. */
const ID_SEP = "\u241f";

/**
 * Name matches beat keyword matches, and nothing matches loosely. cmdk's default
 * is fuzzy, which ranked plextraktsync above plex for "plex" and returned Kroki
 * for "loki" — on a fleet this size the noise costs more than the typo tolerance.
 */
function rankResult(value: string, search: string, keywords?: string[]): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;

  const name = value.split(ID_SEP)[0].toLowerCase();
  if (name === q) return 1;
  if (name.startsWith(q)) return 0.9;
  if (name.includes(q)) return 0.7;

  const kw = (keywords ?? []).map((k) => k.toLowerCase());
  if (kw.some((k) => k === q)) return 0.5;
  if (kw.some((k) => k.startsWith(q))) return 0.4;
  if (kw.some((k) => k.includes(q))) return 0.3;

  return 0;
}

/** cmdk hides non-matches but keeps source order, so relevance is sorted here. */
function byRelevance<T>(items: T[], search: string, fields: (item: T) => [string, string[]]) {
  if (!search.trim()) return items;
  return [...items].sort((a, b) => {
    const [an, ak] = fields(a);
    const [bn, bk] = fields(b);
    return rankResult(bn, search, bk) - rankResult(an, search, ak);
  });
}

export function CommandPalette({ orgId, teamsEnabled = true, activityEnabled = true }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<SearchableApp[]>([]);
  const [projects, setProjects] = useState<SearchableProject[]>([]);
  const [orgEnvKeys, setOrgEnvKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  const rankedApps = useMemo(
    () =>
      byRelevance(apps, search, (a) => [
        a.displayName,
        [a.name, a.projectName, a.imageName, ...a.domains].filter((k): k is string => !!k),
      ]),
    [apps, search],
  );
  const rankedProjects = useMemo(
    () => byRelevance(projects, search, (p) => [p.displayName, [p.name]]),
    [projects, search],
  );

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      setSearch("");
      command();
    },
    []
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for commands and navigate</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[550px]" showCloseButton={false}>
        <Command filter={rankResult} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            placeholder="Search apps, projects, pages..."
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandList className="max-h-[400px]">
            <CommandEmpty>No results found.</CommandEmpty>

            {/* Apps */}
            {apps.length > 0 && (
              <CommandGroup heading="Apps">
                {rankedApps.map((app) => (
                  <CommandItem
                    key={app.id}
                    // Name is the value; everything else is a keyword. Folding
                    // them into one string made cmdk score the blob, which put
                    // plex sixth behind plextraktsync on a search for "plex".
                    value={`${app.displayName}${ID_SEP}${app.id}`}
                    keywords={[app.name, app.projectName, app.imageName, ...app.domains].filter(
                      (k): k is string => !!k,
                    )}
                    onSelect={() => runCommand(() => router.push(`/apps/${app.name}`))}
                    className="gap-2"
                  >
                    <AppIcon app={app} size="sm" />
                    <span>{app.displayName}</span>
                    {app.projectName && (
                      <span className="text-xs text-muted-foreground ml-auto">{app.projectName}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Projects */}
            {projects.length > 0 && (
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
            {orgEnvKeys.length > 0 && (
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

            <CommandSeparator />

            {/* Pages */}
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
              {activityEnabled && (
                <CommandItem
                  value="Activity Log"
                  onSelect={() => runCommand(() => router.push("/activity"))}
                  className="gap-2"
                >
                  <Activity className="size-4" />
                  <span>Activity</span>
                </CommandItem>
              )}
              {teamsEnabled && (
                <CommandItem
                  value="Team Members"
                  onSelect={() => runCommand(() => router.push("/settings/team"))}
                  className="gap-2"
                >
                  <Users className="size-4" />
                  <span>Team</span>
                </CommandItem>
              )}
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

            {/* Admin */}
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
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
