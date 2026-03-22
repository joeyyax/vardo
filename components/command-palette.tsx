"use client";

import { useEffect, useState, useCallback } from "react";
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
} from "lucide-react";
import { AppIcon } from "@/components/app-status";

type CommandPaletteProps = {
  orgId: string | null;
};

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
  envKeys: string[];
};

type SearchableProject = {
  id: string;
  name: string;
  displayName: string;
};

export function CommandPalette({ orgId }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [apps, setApps] = useState<SearchableApp[]>([]);
  const [projects, setProjects] = useState<SearchableProject[]>([]);
  const [orgEnvKeys, setOrgEnvKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      setSearch("");
      command();
    },
    []
  );

  // Global keyboard listener for Cmd/Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
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
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
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
                {apps.map((app) => (
                  <CommandItem
                    key={app.id}
                    value={`${app.displayName} ${app.name} ${app.projectName || ""} ${app.imageName || ""} ${app.domains.join(" ")} ${app.envKeys.join(" ")}`}
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
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${project.displayName} ${project.name}`}
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
                    value={`env variable ${key}`}
                    onSelect={() => runCommand(() => router.push("/settings"))}
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
              <CommandItem
                value="Activity Log"
                onSelect={() => runCommand(() => router.push("/activity"))}
                className="gap-2"
              >
                <Activity className="size-4" />
                <span>Activity</span>
              </CommandItem>
              <CommandItem
                value="Team Members"
                onSelect={() => runCommand(() => router.push("/team"))}
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
                value="Profile Account"
                onSelect={() => runCommand(() => router.push("/profile/account"))}
                className="gap-2"
              >
                <UserCircle className="size-4" />
                <span>Profile</span>
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
                onSelect={() => runCommand(() => router.push("/admin/system"))}
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
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
