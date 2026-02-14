"use client";

import { useState, useEffect, useCallback, ReactNode } from "react";
import { Check, Building2, FolderOpen, ListTodo } from "lucide-react";
import { BudgetBar } from "@/components/ui/budget-bar";
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

interface Task {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  code: string | null;
  tasks: Task[];
  budgetType?: "hours" | "fixed" | null;
  budgetHours?: number | null;
  budgetAmountCents?: number | null;
  totalMinutes?: number;
}

interface Client {
  id: string;
  name: string;
  color: string | null;
  projects: Project[];
}

interface HierarchySelectorProps {
  orgId: string;
  selectedClientId: string | null;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  onSelect: (selection: {
    clientId: string;
    projectId: string | null;
    taskId: string | null;
  }) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A selector that allows choosing at any level of the hierarchy:
 * - Client only
 * - Client + Project
 * - Client + Project + Task
 */
export function HierarchySelector({
  orgId,
  selectedClientId,
  selectedProjectId,
  selectedTaskId,
  onSelect,
  open,
  onOpenChange,
  children,
}: HierarchySelectorProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [hasFetched, setHasFetched] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch clients and projects with tasks in parallel
      const [clientsRes, projectsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/clients`),
        fetch(`/api/v1/organizations/${orgId}/projects?includeTasks=true&includeBudgetUsage=true`),
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
                code: string | null;
                tasks?: { id: string; name: string; isArchived?: boolean }[];
                budgetType?: "hours" | "fixed" | null;
                budgetHours?: number | null;
                budgetAmountCents?: number | null;
                totalMinutes?: number;
              }) => ({
                id: project.id,
                name: project.name,
                code: project.code,
                tasks: (project.tasks || [])
                  .filter((t) => !t.isArchived)
                  .map((t) => ({
                    id: t.id,
                    name: t.name,
                  })),
                budgetType: project.budgetType,
                budgetHours: project.budgetHours,
                budgetAmountCents: project.budgetAmountCents,
                totalMinutes: project.totalMinutes,
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

      setClients(clientsWithProjects);
      setHasFetched(true);
    } catch (error) {
      console.error("Error fetching hierarchy data:", error);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  // Fetch data when popover opens
  useEffect(() => {
    if (open && !hasFetched) {
      fetchData();
    }
  }, [open, hasFetched, fetchData]);

  // Filter based on search
  const filterBySearch = (text: string) => {
    if (!search) return true;
    return text.toLowerCase().includes(search.toLowerCase());
  };

  // Build a flat list of all selectable items for easier rendering
  type SelectableItem =
    | { type: "client"; client: Client }
    | { type: "project"; client: Client; project: Project }
    | { type: "task"; client: Client; project: Project; task: Task };

  const items: SelectableItem[] = [];

  for (const client of clients) {
    // Add client as selectable
    if (filterBySearch(client.name)) {
      items.push({ type: "client", client });
    }

    for (const project of client.projects) {
      // Add project as selectable
      if (filterBySearch(client.name) || filterBySearch(project.name) || filterBySearch(project.code || "")) {
        items.push({ type: "project", client, project });
      }

      for (const task of project.tasks) {
        // Add task as selectable
        if (
          filterBySearch(client.name) ||
          filterBySearch(project.name) ||
          filterBySearch(project.code || "") ||
          filterBySearch(task.name)
        ) {
          items.push({ type: "task", client, project, task });
        }
      }
    }
  }

  const isSelected = (item: SelectableItem) => {
    if (item.type === "client") {
      return selectedClientId === item.client.id && !selectedProjectId && !selectedTaskId;
    }
    if (item.type === "project") {
      return (
        selectedClientId === item.client.id &&
        selectedProjectId === item.project.id &&
        !selectedTaskId
      );
    }
    if (item.type === "task") {
      return (
        selectedClientId === item.client.id &&
        selectedProjectId === item.project.id &&
        selectedTaskId === item.task.id
      );
    }
    return false;
  };

  const handleSelect = (item: SelectableItem) => {
    if (item.type === "client") {
      onSelect({
        clientId: item.client.id,
        projectId: null,
        taskId: null,
      });
    } else if (item.type === "project") {
      onSelect({
        clientId: item.client.id,
        projectId: item.project.id,
        taskId: null,
      });
    } else {
      onSelect({
        clientId: item.client.id,
        projectId: item.project.id,
        taskId: item.task.id,
      });
    }
  };

  const getItemKey = (item: SelectableItem) => {
    if (item.type === "client") return `client-${item.client.id}`;
    if (item.type === "project") return `project-${item.project.id}`;
    return `task-${item.task.id}`;
  };

  const getItemIcon = (type: SelectableItem["type"]) => {
    if (type === "client") return <Building2 className="size-3.5" />;
    if (type === "project") return <FolderOpen className="size-3.5" />;
    return <ListTodo className="size-3.5" />;
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search clients, projects, tasks..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                Loading...
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>
                {search ? "No matches found." : "No clients found."}
              </CommandEmpty>
            ) : (
              <>
                {/* Group items by type for better organization */}
                {items.filter((i) => i.type === "task").length > 0 && (
                  <CommandGroup heading="Tasks">
                    {items
                      .filter((i) => i.type === "task")
                      .map((item) => (
                        <CommandItem
                          key={getItemKey(item)}
                          value={getItemKey(item)}
                          onSelect={() => handleSelect(item)}
                          className="flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div
                              className="size-2 rounded-full shrink-0"
                              style={{
                                backgroundColor: item.client.color || "#6b7280",
                              }}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="text-sm truncate">
                                {item.type === "task" && item.task.name}
                              </span>
                              <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                                {item.client.name} / {item.type === "task" && item.project.name}
                                {item.type === "task" && item.project.budgetType === "hours" && item.project.budgetHours && (
                                  <BudgetBar
                                    mode="dot"
                                    budgetType="hours"
                                    budgetValue={item.project.budgetHours}
                                    usedValue={(item.project.totalMinutes ?? 0) / 60}
                                  />
                                )}
                              </span>
                            </div>
                          </div>
                          {isSelected(item) && (
                            <Check className="size-4 text-primary shrink-0" />
                          )}
                        </CommandItem>
                      ))}
                  </CommandGroup>
                )}

                {items.filter((i) => i.type === "project").length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Projects (no task)">
                      {items
                        .filter((i) => i.type === "project")
                        .map((item) => (
                          <CommandItem
                            key={getItemKey(item)}
                            value={getItemKey(item)}
                            onSelect={() => handleSelect(item)}
                            className="flex items-center justify-between"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div
                                className="size-2 rounded-full shrink-0"
                                style={{
                                  backgroundColor: item.client.color || "#6b7280",
                                }}
                              />
                              <div className="flex flex-col min-w-0">
                                <span className="text-sm truncate flex items-center gap-1">
                                  {item.type === "project" && item.project.name}
                                  {item.type === "project" && item.project.budgetType === "hours" && item.project.budgetHours && (
                                    <BudgetBar
                                      mode="dot"
                                      budgetType="hours"
                                      budgetValue={item.project.budgetHours}
                                      usedValue={(item.project.totalMinutes ?? 0) / 60}
                                    />
                                  )}
                                </span>
                                <span className="text-xs text-muted-foreground truncate">
                                  {item.client.name}
                                </span>
                              </div>
                            </div>
                            {isSelected(item) && (
                              <Check className="size-4 text-primary shrink-0" />
                            )}
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </>
                )}

                {items.filter((i) => i.type === "client").length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Clients (no project)">
                      {items
                        .filter((i) => i.type === "client")
                        .map((item) => (
                          <CommandItem
                            key={getItemKey(item)}
                            value={getItemKey(item)}
                            onSelect={() => handleSelect(item)}
                            className="flex items-center justify-between"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <div
                                className="size-2 rounded-full shrink-0"
                                style={{
                                  backgroundColor: item.client.color || "#6b7280",
                                }}
                              />
                              <span className="text-sm truncate">
                                {item.client.name}
                              </span>
                            </div>
                            {isSelected(item) && (
                              <Check className="size-4 text-primary shrink-0" />
                            )}
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  </>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
