import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";

// Types matching our schema
interface InvoiceLineItem {
  id: string;
  projectName: string;
  taskName: string | null;
  description: string | null;
  minutes: number;
  rate: number; // cents/hour
  amount: number; // cents
}

interface InvoiceData {
  invoiceNumber: string;
  status: string | null;
  periodStart: string;
  periodEnd: string;
  subtotal: number; // cents
  totalMinutes: number;
  createdAt: Date;
  lineItems: InvoiceLineItem[];
  client: {
    name: string;
  };
  organization: {
    name: string;
  };
}

// Styles
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1f2937",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 40,
  },
  headerLeft: {
    flex: 1,
  },
  headerRight: {
    textAlign: "right",
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 8,
  },
  orgName: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#374151",
  },
  invoiceNumber: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 4,
  },
  metaSection: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
  },
  metaBox: {
    width: "48%",
  },
  metaLabel: {
    fontSize: 9,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metaValue: {
    fontSize: 11,
    color: "#111827",
  },
  clientName: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#111827",
  },
  table: {
    marginTop: 20,
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f9fafb",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  tableHeaderText: {
    fontSize: 9,
    fontWeight: "bold",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  colDescription: {
    flex: 4,
  },
  colHours: {
    flex: 1,
    textAlign: "right",
  },
  colRate: {
    flex: 1,
    textAlign: "right",
  },
  colAmount: {
    flex: 1,
    textAlign: "right",
  },
  projectName: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#111827",
  },
  taskName: {
    fontSize: 10,
    color: "#6b7280",
    marginTop: 2,
  },
  description: {
    fontSize: 9,
    color: "#6b7280",
    marginTop: 4,
    lineHeight: 1.4,
  },
  cellText: {
    fontSize: 10,
    color: "#374151",
  },
  totalsSection: {
    marginTop: 20,
    borderTopWidth: 2,
    borderTopColor: "#e5e7eb",
    paddingTop: 20,
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 8,
  },
  totalsLabel: {
    width: 120,
    textAlign: "right",
    fontSize: 10,
    color: "#6b7280",
    paddingRight: 20,
  },
  totalsValue: {
    width: 100,
    textAlign: "right",
    fontSize: 10,
    color: "#374151",
  },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  grandTotalLabel: {
    width: 120,
    textAlign: "right",
    fontSize: 14,
    fontWeight: "bold",
    color: "#111827",
    paddingRight: 20,
  },
  grandTotalValue: {
    width: 100,
    textAlign: "right",
    fontSize: 14,
    fontWeight: "bold",
    color: "#111827",
  },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 40,
    right: 40,
    textAlign: "center",
    fontSize: 9,
    color: "#9ca3af",
  },
});

// Helper functions
function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return hours.toFixed(2);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateRange(start: string, end: string): string {
  return `${formatDate(start)} - ${formatDate(end)}`;
}

// Component
export function InvoicePdfTemplate({ data }: { data: InvoiceData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>Invoice</Text>
            <Text style={styles.orgName}>{data.organization.name}</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
          </View>
        </View>

        {/* Meta Section */}
        <View style={styles.metaSection}>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Bill To</Text>
            <Text style={styles.clientName}>{data.client.name}</Text>
          </View>
          <View style={styles.metaBox}>
            <Text style={styles.metaLabel}>Invoice Date</Text>
            <Text style={styles.metaValue}>
              {data.createdAt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
            <Text style={[styles.metaLabel, { marginTop: 12 }]}>Period</Text>
            <Text style={styles.metaValue}>
              {formatDateRange(data.periodStart, data.periodEnd)}
            </Text>
          </View>
        </View>

        {/* Table */}
        <View style={styles.table}>
          {/* Header */}
          <View style={styles.tableHeader}>
            <View style={styles.colDescription}>
              <Text style={styles.tableHeaderText}>Description</Text>
            </View>
            <View style={styles.colHours}>
              <Text style={styles.tableHeaderText}>Hours</Text>
            </View>
            <View style={styles.colRate}>
              <Text style={styles.tableHeaderText}>Rate</Text>
            </View>
            <View style={styles.colAmount}>
              <Text style={styles.tableHeaderText}>Amount</Text>
            </View>
          </View>

          {/* Rows */}
          {data.lineItems.map((item) => (
            <View key={item.id} style={styles.tableRow}>
              <View style={styles.colDescription}>
                <Text style={styles.projectName}>{item.projectName}</Text>
                {item.taskName && (
                  <Text style={styles.taskName}>{item.taskName}</Text>
                )}
                {item.description && (
                  <Text style={styles.description}>{item.description}</Text>
                )}
              </View>
              <View style={styles.colHours}>
                <Text style={styles.cellText}>{formatHours(item.minutes)}</Text>
              </View>
              <View style={styles.colRate}>
                <Text style={styles.cellText}>
                  {formatCurrency(item.rate)}/hr
                </Text>
              </View>
              <View style={styles.colAmount}>
                <Text style={styles.cellText}>{formatCurrency(item.amount)}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsSection}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Total Hours</Text>
            <Text style={styles.totalsValue}>
              {formatHours(data.totalMinutes)}
            </Text>
          </View>
          <View style={styles.grandTotal}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>
              {formatCurrency(data.subtotal)}
            </Text>
          </View>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          Thank you for your business
        </Text>
      </Page>
    </Document>
  );
}

export type { InvoiceData, InvoiceLineItem };
