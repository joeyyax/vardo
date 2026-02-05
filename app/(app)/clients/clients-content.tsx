"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Plus, DollarSign, Users, Edit, GripVertical, Search, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClientDialog, type Client } from "@/components/clients/client-dialog";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from "@dnd-kit/core";

type ClientsContentProps = {
  orgId: string;
};

export function ClientsContent({ orgId }: ClientsContentProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  // Filter/sort state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "recent">("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  // Drag state
  const [activeId, setActiveId] = useState<string | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
      if (!response.ok) {
        throw new Error("Failed to fetch clients");
      }
      const data = await response.json();
      setClients(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const handleNewClient = () => {
    setSelectedClient(null);
    setDialogOpen(true);
  };

  const handleEditClient = (client: Client) => {
    setSelectedClient(client);
    setDialogOpen(true);
  };

  const handleSuccess = () => {
    fetchClients();
  };

  const updateClientParent = async (clientId: string, parentClientId: string | null) => {
    const client = clients.find((c) => c.id === clientId);
    const parent = parentClientId ? clients.find((c) => c.id === parentClientId) : null;

    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentClientId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update client");
      }

      fetchClients();
      toast.success(
        parentClientId
          ? `Moved "${client?.name}" under "${parent?.name}"`
          : `Made "${client?.name}" a top-level client`
      );
    } catch (err) {
      console.error("Error updating client:", err);
      toast.error("Failed to move client");
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;

    const draggedClient = clients.find((c) => c.id === active.id);
    if (!draggedClient) return;

    const draggedHasChildren = clients.some((c) => c.parentClientId === draggedClient.id);

    // Dropped on "root" = make top-level
    if (over.id === "root") {
      if (draggedClient.parentClientId) {
        updateClientParent(draggedClient.id, null);
      }
      return;
    }

    // Dropped on a client = make it a child of that client
    const targetClient = clients.find((c) => c.id === over.id);
    if (!targetClient) return;

    // Validation
    if (draggedHasChildren) return; // Can't nest a parent
    if (targetClient.parentClientId) return; // Can't drop onto a child
    if (targetClient.id === draggedClient.id) return; // Can't drop on self
    if (targetClient.id === draggedClient.parentClientId) return; // Already a child

    updateClientParent(draggedClient.id, targetClient.id);
  };

  const activeClient = activeId ? clients.find((c) => c.id === activeId) : null;

  // Filter and sort clients (must be before early returns to maintain hook order)
  const filteredAndSortedClients = useMemo(() => {
    let result = [...clients];

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(query));
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;
      if (sortBy === "name") {
        comparison = a.name.localeCompare(b.name);
      } else if (sortBy === "recent") {
        // Sort by updatedAt (most recently updated first by default)
        const aDate = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bDate = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        comparison = bDate - aDate; // Default: most recent first
      }
      return sortOrder === "desc" ? -comparison : comparison;
    });

    return result;
  }, [clients, searchQuery, sortBy, sortOrder]);

  // Organize clients into hierarchy
  const topLevel = filteredAndSortedClients.filter((c) => !c.parentClientId);
  const childrenByParent = new Map<string, Client[]>();
  filteredAndSortedClients.forEach((client) => {
    if (client.parentClientId) {
      const existing = childrenByParent.get(client.parentClientId) || [];
      existing.push(client);
      childrenByParent.set(client.parentClientId, existing);
    }
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg border bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchClients} className="mt-4 squircle">
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with filters and new button */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div className="flex flex-1 gap-2">
            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search clients..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Sort by */}
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as "name" | "recent")}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="recent">Recent</SelectItem>
              </SelectContent>
            </Select>

            {/* Sort order */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
              title={sortOrder === "asc" ? "Ascending" : "Descending"}
            >
              <ArrowUpDown className={`size-4 transition-transform ${sortOrder === "desc" ? "rotate-180" : ""}`} />
            </Button>
          </div>

          <Button onClick={handleNewClient} className="squircle">
            <Plus className="size-4" />
            New client
          </Button>
        </div>

        {clients.length === 0 ? (
          <EmptyState onNewClient={handleNewClient} />
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <RootDropZone isActive={!!activeId && !!activeClient?.parentClientId}>
              <div className="space-y-2">
                {topLevel.map((client) => {
                  const children = childrenByParent.get(client.id) || [];
                  return (
                    <div key={client.id}>
                      <DroppableClientRow
                        client={client}
                        onEdit={() => handleEditClient(client)}
                        childCount={children.length}
                        isDragging={activeId === client.id}
                        isValidTarget={!!activeId && activeId !== client.id && !clients.some((c) => c.parentClientId === clients.find((cl) => cl.id === activeId)?.id)}
                      />
                      {children.length > 0 && (
                        <div className="ml-6 mt-1 space-y-1 border-l-2 border-muted pl-4">
                          {children.map((child) => (
                            <DraggableClientRow
                              key={child.id}
                              client={child}
                              onEdit={() => handleEditClient(child)}
                              isChild
                              isDragging={activeId === child.id}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </RootDropZone>

            <DragOverlay>
              {activeClient && <ClientRowOverlay client={activeClient} />}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      <ClientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={selectedClient}
        orgId={orgId}
        allClients={clients}
        onSuccess={handleSuccess}
      />
    </>
  );
}

// Root drop zone - dropping here makes client top-level
function RootDropZone({ children, isActive }: { children: React.ReactNode; isActive: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "root" });

  return (
    <div
      ref={setNodeRef}
      className="min-h-[200px] rounded-lg transition-colors"
    >
      {children}
      {isActive && (
        <div
          className={`mt-4 rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ${
            isOver ? "border-primary bg-primary/5 text-primary" : "border-muted/50 text-muted-foreground"
          }`}
        >
          Drop here to make top-level
        </div>
      )}
    </div>
  );
}

// Top-level client: both draggable AND droppable
function DroppableClientRow({
  client,
  onEdit,
  childCount = 0,
  isDragging = false,
  isValidTarget = false,
}: {
  client: Client;
  onEdit: () => void;
  childCount?: number;
  isDragging?: boolean;
  isValidTarget?: boolean;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform } = useDraggable({ id: client.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: client.id });

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  const formattedRate = client.rateOverride ? `$${(client.rateOverride / 100).toFixed(2)}/hr` : null;

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      style={style}
      className={`squircle flex items-center gap-2 rounded-lg border bg-card p-4 transition-all ${
        isOver && isValidTarget ? "ring-2 ring-primary ring-offset-2 bg-primary/5" : "hover:bg-accent/50"
      } ${isDragging ? "opacity-50" : ""}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>

      <Link href={`/clients/${client.id}`} className="flex-1 min-w-0 flex items-center gap-4">
        <div
          className="size-3 shrink-0 rounded-full ring-1 ring-border"
          style={{ backgroundColor: client.color || "#94a3b8" }}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{client.name}</div>
          {childCount > 0 && (
            <div className="text-xs text-muted-foreground">
              {childCount} sub-client{childCount !== 1 ? "s" : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {formattedRate ? (
            <span className="text-sm text-muted-foreground">{formattedRate}</span>
          ) : (
            <span className="text-sm text-muted-foreground/60">Default rate</span>
          )}
          {client.isBillable !== null && (
            <div className={`flex items-center gap-1 text-xs ${client.isBillable ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
              <DollarSign className="size-3" />
              {client.isBillable ? "Billable" : "Non-billable"}
            </div>
          )}
        </div>
      </Link>

      <Button variant="ghost" size="icon" onClick={onEdit} className="squircle shrink-0">
        <Edit className="size-4" />
      </Button>
    </div>
  );
}

// Child client: only draggable (not a drop target)
function DraggableClientRow({
  client,
  onEdit,
  isChild = false,
  isDragging = false,
}: {
  client: Client;
  onEdit: () => void;
  isChild?: boolean;
  isDragging?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: client.id });

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  const formattedRate = client.rateOverride ? `$${(client.rateOverride / 100).toFixed(2)}/hr` : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`squircle flex items-center gap-2 rounded-lg border bg-card p-4 transition-all hover:bg-accent/50 ${isDragging ? "opacity-50" : ""}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>

      <Link href={`/clients/${client.id}`} className="flex-1 min-w-0 flex items-center gap-4">
        <div
          className="size-3 shrink-0 rounded-full ring-1 ring-border"
          style={{ backgroundColor: client.color || "#94a3b8" }}
        />
        <div className="flex-1 min-w-0">
          <div className={`font-medium truncate ${isChild ? "text-sm" : ""}`}>{client.name}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {formattedRate ? (
            <span className="text-sm text-muted-foreground">{formattedRate}</span>
          ) : (
            <span className="text-sm text-muted-foreground/60">Default rate</span>
          )}
          {client.isBillable !== null && (
            <div className={`flex items-center gap-1 text-xs ${client.isBillable ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
              <DollarSign className="size-3" />
              {client.isBillable ? "Billable" : "Non-billable"}
            </div>
          )}
        </div>
      </Link>

      <Button variant="ghost" size="icon" onClick={onEdit} className="squircle shrink-0">
        <Edit className="size-4" />
      </Button>
    </div>
  );
}

function ClientRowOverlay({ client }: { client: Client }) {
  return (
    <div className="squircle flex items-center gap-2 rounded-lg border bg-card p-4 shadow-lg">
      <div className="p-1 text-muted-foreground">
        <GripVertical className="size-4" />
      </div>
      <div
        className="size-3 shrink-0 rounded-full ring-1 ring-border"
        style={{ backgroundColor: client.color || "#94a3b8" }}
      />
      <div className="font-medium">{client.name}</div>
    </div>
  );
}

function EmptyState({ onNewClient }: { onNewClient: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Users className="size-6 text-muted-foreground" />
      </div>
      <h3 className="mt-4 text-lg font-medium">No clients yet</h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-sm">
        Clients help you organize your work and track time by customer. Add your first one to get started.
      </p>
      <Button onClick={onNewClient} className="mt-6 squircle">
        <Plus className="size-4" />
        Add your first client
      </Button>
    </div>
  );
}
