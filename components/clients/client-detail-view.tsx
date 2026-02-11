"use client";

import { Badge } from "@/components/ui/badge";
import { DetailField } from "@/components/ui/detail-field";
import { Mail, Phone } from "lucide-react";
import type { Client, ClientContact } from "./client-dialog";

const BILLING_TYPE_LABELS: Record<string, string> = {
  hourly: "Hourly",
  retainer_fixed: "Fixed Retainer",
  retainer_capped: "Capped Retainer",
  retainer_uncapped: "Uncapped Retainer",
  fixed_project: "Fixed Project",
};

const BILLING_FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  per_project: "Per Project",
};

const DAYS_OF_WEEK_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const CONTACT_TYPE_LABELS: Record<string, string> = {
  primary: "Primary",
  billing: "Billing",
  other: "Other",
};

const CONTACT_TYPE_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  primary: "default",
  billing: "secondary",
  other: "outline",
};

type ClientDetailViewProps = {
  client: Client;
  contacts: ClientContact[];
  parentClient?: Client | null;
  onEdit: () => void;
};

export function ClientDetailView({ client, contacts, parentClient }: ClientDetailViewProps) {
  const formatRate = (cents: number | null) => {
    if (cents === null) return null;
    return `$${(cents / 100).toFixed(2)}`;
  };

  const formatAmount = (cents: number | null) => {
    if (cents === null) return null;
    return `$${(cents / 100).toFixed(2)}`;
  };

  const hasBillingSettings =
    client.billingType ||
    client.billingFrequency ||
    client.autoGenerateInvoices ||
    client.retainerAmount ||
    client.paymentTermsDays;

  return (
    <div className="space-y-6">
      {/* Basic info */}
      <div className="space-y-4">
        <DetailField label="Client name">
          <div className="flex items-center gap-2">
            {client.color && (
              <div
                className="size-3 shrink-0 rounded-full ring-1 ring-border"
                style={{ backgroundColor: client.color }}
              />
            )}
            <span className="text-sm font-medium">{client.name}</span>
          </div>
        </DetailField>

        {parentClient && (
          <DetailField label="Parent client">
            <div className="flex items-center gap-2">
              {parentClient.color && (
                <div
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
                  style={{ backgroundColor: parentClient.color }}
                />
              )}
              <span className="text-sm text-muted-foreground">{parentClient.name}</span>
            </div>
          </DetailField>
        )}

        <DetailField label="Hourly rate">
          {formatRate(client.rateOverride) || (
            <span className="italic">Inherits from organization</span>
          )}
        </DetailField>

        <DetailField label="Billable">
          {client.isBillable === null ? (
            <span className="italic">Inherits from organization</span>
          ) : client.isBillable ? (
            "Yes"
          ) : (
            "No"
          )}
        </DetailField>
      </div>

      {/* Contacts */}
      <div className="border-t pt-4">
        <h4 className="text-sm font-medium mb-3">Contacts</h4>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No contacts added yet</p>
        ) : (
          <div className="space-y-3">
            {contacts.map((contact) => (
              <div key={contact.id} className="flex items-start gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{contact.name}</span>
                    <Badge variant={CONTACT_TYPE_VARIANTS[contact.type] ?? "outline"} className="text-[10px] px-1.5 py-0">
                      {CONTACT_TYPE_LABELS[contact.type] ?? contact.type}
                    </Badge>
                  </div>
                  {contact.title && (
                    <p className="text-xs text-muted-foreground">{contact.title}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {contact.email && (
                      <a
                        href={`mailto:${contact.email}`}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Mail className="size-3" />
                        {contact.email}
                      </a>
                    )}
                    {contact.phone && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Phone className="size-3" />
                        {contact.phone}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Billing settings */}
      {hasBillingSettings && (
        <>
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium mb-3">Billing Configuration</h4>
            <div className="space-y-4">
              {client.billingType && (
                <DetailField label="Billing type">
                  {BILLING_TYPE_LABELS[client.billingType] || client.billingType}
                </DetailField>
              )}

              {client.billingFrequency && (
                <DetailField label="Billing frequency">
                  {BILLING_FREQUENCY_LABELS[client.billingFrequency] ||
                    client.billingFrequency}
                </DetailField>
              )}

              {client.retainerAmount !== null && (
                <DetailField label="Retainer amount">
                  {formatAmount(client.retainerAmount)}
                </DetailField>
              )}

              {client.billingDayOfWeek !== null && (
                <DetailField label="Billing day (weekly)">
                  {DAYS_OF_WEEK_LABELS[client.billingDayOfWeek]}
                </DetailField>
              )}

              {client.billingDayOfMonth !== null && (
                <DetailField label="Billing day (monthly)">
                  Day {client.billingDayOfMonth}
                </DetailField>
              )}

              {client.paymentTermsDays !== null && (
                <DetailField label="Payment terms">
                  Net {client.paymentTermsDays} days
                </DetailField>
              )}

              {client.autoGenerateInvoices && (
                <DetailField label="Auto-generate invoices">
                  <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                    Enabled
                  </Badge>
                </DetailField>
              )}

              {client.lastInvoicedDate && (
                <DetailField label="Last invoiced">
                  {new Date(client.lastInvoicedDate).toLocaleDateString()}
                </DetailField>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
