"use client";

import { useState, useEffect, useCallback, ReactNode } from "react";
import { Check, Building2, FolderOpen } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
};

type ProjectSelectorProps = {
  orgId: string;
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

export function ProjectSelector({
  orgId,
  selectedProjectId,
  onSelect,
  open,
  onOpenChange,
  children,
}: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hasFetched, setHasFetched] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (error) {
      console.error("Error fetching projects:", error);
    } finally {
      setLoading(false);
      setHasFetched(true);
    }
  }, [orgId]);

  useEffect(() => {
    if (open && !hasFetched) {
      fetchProjects();
    }
  }, [open, hasFetched, fetchProjects]);

  // Filter projects by search
  const filteredProjects = projects.filter((p) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(searchLower) ||
      p.client.name.toLowerCase().includes(searchLower)
    );
  });

  // Group projects by client
  const projectsByClient = filteredProjects.reduce(
    (acc, project) => {
      const clientId = project.client.id;
      if (!acc[clientId]) {
        acc[clientId] = {
          client: project.client,
          projects: [],
        };
      }
      acc[clientId].projects.push(project);
      return acc;
    },
    {} as Record<string, { client: Project["client"]; projects: Project[] }>
  );

  const handleSelect = (projectId: string | null) => {
    onSelect(projectId);
    onOpenChange(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search projects..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                Loading...
              </div>
            ) : (
              <>
                {/* Overhead option */}
                <CommandGroup>
                  <CommandItem
                    value="overhead"
                    onSelect={() => handleSelect(null)}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 text-amber-500" />
                      <span>Overhead (General Business)</span>
                    </div>
                    {selectedProjectId === null && (
                      <Check className="size-4 text-primary" />
                    )}
                  </CommandItem>
                </CommandGroup>

                <CommandSeparator />

                {/* Projects grouped by client */}
                {Object.values(projectsByClient).length === 0 ? (
                  <CommandEmpty>
                    {search ? "No projects found." : "No projects available."}
                  </CommandEmpty>
                ) : (
                  Object.values(projectsByClient).map(({ client, projects: clientProjects }) => (
                    <CommandGroup key={client.id} heading={client.name}>
                      {clientProjects.map((project) => (
                        <CommandItem
                          key={project.id}
                          value={project.id}
                          onSelect={() => handleSelect(project.id)}
                          className="flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div
                              className="size-2 rounded-full shrink-0"
                              style={{ backgroundColor: client.color || "#6b7280" }}
                            />
                            <span className="truncate">{project.name}</span>
                          </div>
                          {selectedProjectId === project.id && (
                            <Check className="size-4 text-primary shrink-0" />
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
