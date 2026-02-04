"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, DollarSign, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClientDialog, type Client } from "@/components/clients/client-dialog";

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

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border bg-muted/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchClients}
          className="mt-4 squircle"
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with new button */}
        <div className="flex justify-end">
          <Button onClick={handleNewClient} className="squircle">
            <Plus className="size-4" />
            New client
          </Button>
        </div>

        {/* Clients list or empty state */}
        {clients.length === 0 ? (
          <EmptyState onNewClient={handleNewClient} />
        ) : (
          <div className="space-y-2">
            {clients.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                onClick={() => handleEditClient(client)}
              />
            ))}
          </div>
        )}
      </div>

      <ClientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        client={selectedClient}
        orgId={orgId}
        onSuccess={handleSuccess}
      />
    </>
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
        Clients help you organize your work and track time by customer. Add your
        first one to get started.
      </p>
      <Button onClick={onNewClient} className="mt-6 squircle">
        <Plus className="size-4" />
        Add your first client
      </Button>
    </div>
  );
}

function ClientRow({
  client,
  onClick,
}: {
  client: Client;
  onClick: () => void;
}) {
  // Format rate for display (cents to dollars)
  const formattedRate = client.rateOverride
    ? `$${(client.rateOverride / 100).toFixed(2)}/hr`
    : null;

  return (
    <button
      onClick={onClick}
      className="squircle w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex items-center gap-4">
        {/* Color indicator */}
        <div
          className="size-3 shrink-0 rounded-full ring-1 ring-border"
          style={{
            backgroundColor: client.color || "#94a3b8",
          }}
        />

        {/* Client info */}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{client.name}</div>
        </div>

        {/* Rate badge */}
        <div className="flex items-center gap-3 shrink-0">
          {formattedRate ? (
            <span className="text-sm text-muted-foreground">{formattedRate}</span>
          ) : (
            <span className="text-sm text-muted-foreground/60">Default rate</span>
          )}

          {/* Billable indicator */}
          {client.isBillable !== null && (
            <div
              className={`flex items-center gap-1 text-xs ${
                client.isBillable
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
              }`}
            >
              <DollarSign className="size-3" />
              {client.isBillable ? "Billable" : "Non-billable"}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
