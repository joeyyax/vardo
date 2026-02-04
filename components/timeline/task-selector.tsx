"use client";

import { useState, useEffect, useCallback, ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
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
} from "@/components/ui/command";

interface Task {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  tasks: Task[];
}

interface Client {
  id: string;
  name: string;
  color: string | null;
  projects: Project[];
}

interface TaskSelectorProps {
  orgId: string;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function TaskSelector({
  orgId,
  selectedTaskId,
  onSelect,
  open,
  onOpenChange,
  children,
}: TaskSelectorProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hasFetched, setHasFetched] = useState(false);

  const fetchClientsWithTasks = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch clients and projects with tasks in parallel
      const [clientsRes, projectsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/clients`),
        fetch(`/api/v1/organizations/${orgId}/projects?includeTasks=true`),
      ]);

      if (!clientsRes.ok) throw new Error("Failed to fetch clients");
      if (!projectsRes.ok) throw new Error("Failed to fetch projects");

      const clientsData = await clientsRes.json();
      const projectsData = await projectsRes.json();

      // Build the nested structure
      const clientsWithProjects: Client[] = clientsData.map(
        (client: { id: string; name: string; color: string | null }) => {
          const clientProjects = projectsData
            .filter(
              (p: { clientId: string; isArchived: boolean }) =>
                p.clientId === client.id && !p.isArchived
            )
            .map(
              (project: {
                id: string;
                name: string;
                tasks?: { id: string; name: string; isArchived?: boolean }[];
              }) => ({
                id: project.id,
                name: project.name,
                tasks: (project.tasks || [])
                  .filter((t) => !t.isArchived)
                  .map((t) => ({
                    id: t.id,
                    name: t.name,
                  })),
              })
            );

          return {
            id: client.id,
            name: client.name,
            color: client.color,
            projects: clientProjects,
          };
        }
      );

      // Filter out clients with no projects or projects without tasks
      const filtered = clientsWithProjects
        .map((c) => ({
          ...c,
          projects: c.projects.filter((p) => p.tasks.length > 0),
        }))
        .filter((c) => c.projects.length > 0);

      setClients(filtered);
      setHasFetched(true);
    } catch (error) {
      console.error("Error fetching clients:", error);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  // Fetch clients with projects and tasks when popover opens
  useEffect(() => {
    if (open && !hasFetched) {
      fetchClientsWithTasks();
    }
  }, [open, hasFetched, fetchClientsWithTasks]);

  // Filter based on search
  const filteredClients = clients
    .map((client) => {
      const filteredProjects = client.projects
        .map((project) => {
          const filteredTasks = project.tasks.filter(
            (task) =>
              !search ||
              task.name.toLowerCase().includes(search.toLowerCase()) ||
              project.name.toLowerCase().includes(search.toLowerCase()) ||
              client.name.toLowerCase().includes(search.toLowerCase())
          );
          return { ...project, tasks: filteredTasks };
        })
        .filter((project) => project.tasks.length > 0);
      return { ...client, projects: filteredProjects };
    })
    .filter((client) => client.projects.length > 0);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search tasks..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                Loading...
              </div>
            ) : filteredClients.length === 0 ? (
              <CommandEmpty>No tasks found.</CommandEmpty>
            ) : (
              filteredClients.map((client) => (
                <CommandGroup
                  key={client.id}
                  heading={
                    <div className="flex items-center gap-2">
                      <div
                        className="size-2 rounded-full"
                        style={{
                          backgroundColor: client.color || "#6b7280",
                        }}
                      />
                      {client.name}
                    </div>
                  }
                >
                  {client.projects.map((project) =>
                    project.tasks.map((task) => (
                      <CommandItem
                        key={task.id}
                        value={task.id}
                        onSelect={() => onSelect(task.id)}
                        className="flex items-center justify-between"
                      >
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-muted-foreground">
                            {project.name}
                          </span>
                          {task.name !== "Default" && (
                            <>
                              <ChevronRight className="size-3 text-muted-foreground/50" />
                              <span>{task.name}</span>
                            </>
                          )}
                        </div>
                        {selectedTaskId === task.id && (
                          <Check className="size-4 text-primary" />
                        )}
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
