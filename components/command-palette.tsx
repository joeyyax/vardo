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
  Clock,
  Users,
  Folder,
  Settings,
  FileText,
  BarChart3,
  Plus,
} from "lucide-react";

type CommandPaletteProps = {
  orgId: string | null;
};

type SearchResult = {
  id: string;
  type: "client" | "project";
  name: string;
  color?: string | null;
  parentName?: string;
};

export function CommandPalette({ orgId }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const router = useRouter();

  // Callbacks (defined before useEffects that depend on them)
  const focusEntryBar = useCallback(() => {
    // Focus the description input in the entry bar
    const descriptionInput = document.querySelector(
      'input[placeholder="What did you work on?"]'
    ) as HTMLInputElement | null;
    descriptionInput?.focus();
  }, []);

  const runCommand = useCallback(
    (command: () => void) => {
      setOpen(false);
      setSearch("");
      command();
    },
    []
  );

  // Global keyboard listener for Cmd/Ctrl+K and /
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K toggles command palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      // "/" focuses entry bar (only when not typing in an input)
      if (e.key === "/" && !open) {
        const target = e.target as HTMLElement;
        const isInInput =
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable;

        if (!isInInput) {
          e.preventDefault();
          focusEntryBar();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, focusEntryBar]);

  // Search for clients and projects
  useEffect(() => {
    if (!orgId || !search.trim()) {
      setSearchResults([]);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(async () => {
      setIsSearching(true);
      try {
        // Fetch clients matching search
        const clientsRes = await fetch(
          `/api/v1/organizations/${orgId}/clients?search=${encodeURIComponent(search)}`,
          { signal: controller.signal }
        );
        const clientsData = await clientsRes.json();

        // Fetch projects matching search
        const projectsRes = await fetch(
          `/api/v1/organizations/${orgId}/projects?search=${encodeURIComponent(search)}`,
          { signal: controller.signal }
        );
        const projectsData = await projectsRes.json();

        const results: SearchResult[] = [];

        // Add matching clients
        if (clientsData.clients) {
          for (const client of clientsData.clients.slice(0, 5)) {
            results.push({
              id: client.id,
              type: "client",
              name: client.name,
              color: client.color,
            });
          }
        }

        // Add matching projects
        if (projectsData.projects) {
          for (const project of projectsData.projects.slice(0, 5)) {
            results.push({
              id: project.id,
              type: "project",
              name: project.name,
              parentName: project.client?.name,
            });
          }
        }

        setSearchResults(results);
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("Search failed:", err);
        }
      } finally {
        setIsSearching(false);
      }
    }, 200);

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [orgId, search]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for commands and navigate</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[550px]" showCloseButton={false}>
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            placeholder="Type a command or search..."
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandList className="max-h-[400px]">
            <CommandEmpty>
              {isSearching ? "Searching..." : "No results found."}
            </CommandEmpty>

            {/* Quick Actions */}
            {!search && (
              <CommandGroup heading="Actions">
                <CommandItem
                  onSelect={() => runCommand(focusEntryBar)}
                  className="gap-2"
                >
                  <Clock className="size-4" />
                  <span>New time entry</span>
                  <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                    /
                  </kbd>
                </CommandItem>
                <CommandItem
                  onSelect={() =>
                    runCommand(() => {
                      router.push("/clients");
                      // Trigger new client dialog via custom event
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent("new-client"));
                      }, 100);
                    })
                  }
                  className="gap-2"
                >
                  <Plus className="size-4" />
                  <span>New client</span>
                </CommandItem>
                <CommandItem
                  onSelect={() =>
                    runCommand(() => {
                      router.push("/projects");
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent("new-project"));
                      }, 100);
                    })
                  }
                  className="gap-2"
                >
                  <Plus className="size-4" />
                  <span>New project</span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Navigation */}
            {!search && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Navigation">
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/track"))}
                    className="gap-2"
                  >
                    <Clock className="size-4" />
                    <span>Track time</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/reports"))}
                    className="gap-2"
                  >
                    <BarChart3 className="size-4" />
                    <span>Reports</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/invoices"))}
                    className="gap-2"
                  >
                    <FileText className="size-4" />
                    <span>Invoices</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/clients"))}
                    className="gap-2"
                  >
                    <Users className="size-4" />
                    <span>Clients</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/projects"))}
                    className="gap-2"
                  >
                    <Folder className="size-4" />
                    <span>Projects</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => runCommand(() => router.push("/settings"))}
                    className="gap-2"
                  >
                    <Settings className="size-4" />
                    <span>Settings</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {/* Search Results */}
            {search && searchResults.length > 0 && (
              <CommandGroup heading="Results">
                {searchResults.map((result) => (
                  <CommandItem
                    key={`${result.type}-${result.id}`}
                    onSelect={() =>
                      runCommand(() =>
                        router.push(
                          result.type === "client"
                            ? `/clients/${result.id}`
                            : `/projects/${result.id}`
                        )
                      )
                    }
                    className="gap-2"
                  >
                    {result.type === "client" ? (
                      <>
                        {result.color && (
                          <span
                            className="size-3 rounded-full shrink-0"
                            style={{ backgroundColor: result.color }}
                          />
                        )}
                        {!result.color && <Users className="size-4" />}
                        <span>{result.name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          Client
                        </span>
                      </>
                    ) : (
                      <>
                        <Folder className="size-4" />
                        <span>{result.name}</span>
                        {result.parentName && (
                          <span className="text-xs text-muted-foreground">
                            {result.parentName}
                          </span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          Project
                        </span>
                      </>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
