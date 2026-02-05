import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";

// Types
type ReportPdfData = {
  organizationName: string;
  reportTitle: string;
  dateRange: string;
  generatedAt: string;
  financial?: {
    revenue: number;
    expenses: number;
    profit: number;
    outstanding: number;
  };
  timeByClient?: Array<{
    name: string;
    billableHours: number;
    unbillableHours: number;
    amount: number;
  }>;
  expensesByCategory?: Array<{
    category: string;
    amount: number;
  }>;
  invoiceStatus?: {
    paid: number;
    pending: number;
    overdue: number;
    draft: number;
  };
  accountingMonths?: Array<{
    month: string;
    income: number;
    expenses: number;
    profit: number;
  }>;
};

// Styles — matching invoice template's font/color scheme
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#1f2937",
  },
  header: {
    marginBottom: 30,
  },
  orgName: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#374151",
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 8,
  },
  dateRange: {
    fontSize: 11,
    color: "#6b7280",
    marginBottom: 2,
  },
  generatedAt: {
    fontSize: 9,
    color: "#9ca3af",
  },

  // Section
  section: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 12,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },

  // Financial summary grid (2x2)
  financialGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  financialCell: {
    width: "48%",
    backgroundColor: "#f9fafb",
    padding: 14,
    borderRadius: 4,
  },
  financialLabel: {
    fontSize: 9,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  financialValue: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#111827",
  },

  // Tables
  table: {
    marginTop: 4,
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
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  tableRowAlt: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#f9fafb",
  },
  cellText: {
    fontSize: 10,
    color: "#374151",
  },
  cellBold: {
    fontSize: 10,
    fontWeight: "bold",
    color: "#111827",
  },

  // Column widths for time-by-client table
  colClient: { flex: 3 },
  colBillable: { flex: 1.5, textAlign: "right" },
  colUnbillable: { flex: 1.5, textAlign: "right" },
  colAmount: { flex: 1.5, textAlign: "right" },

  // Column widths for expenses-by-category table
  colCategory: { flex: 3 },
  colCategoryAmount: { flex: 1.5, textAlign: "right" },

  // Column widths for accounting-by-month table
  colMonth: { flex: 2 },
  colIncome: { flex: 1.5, textAlign: "right" },
  colExpenses: { flex: 1.5, textAlign: "right" },
  colProfit: { flex: 1.5, textAlign: "right" },

  // Invoice status summary row
  statusGrid: {
    flexDirection: "row",
    gap: 12,
  },
  statusCell: {
    flex: 1,
    backgroundColor: "#f9fafb",
    padding: 12,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 9,
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 13,
    fontWeight: "bold",
    color: "#111827",
  },

  // Totals row at bottom of tables
  totalsRow: {
    flexDirection: "row",
    borderTopWidth: 2,
    borderTopColor: "#e5e7eb",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },

  // Footer
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

// Helpers
function formatCurrency(cents: number): string {
  const abs = Math.abs(cents);
  const formatted = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `-$${formatted}` : `$${formatted}`;
}

function formatHours(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

// Sections
function FinancialSummary({ data }: { data: NonNullable<ReportPdfData["financial"]> }) {
  const items = [
    { label: "Revenue", value: data.revenue },
    { label: "Expenses", value: data.expenses },
    { label: "Profit", value: data.profit },
    { label: "Outstanding", value: data.outstanding },
  ];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Financial Summary</Text>
      <View style={styles.financialGrid}>
        {items.map((item) => (
          <View key={item.label} style={styles.financialCell}>
            <Text style={styles.financialLabel}>{item.label}</Text>
            <Text style={styles.financialValue}>{formatCurrency(item.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function TimeByClient({ data }: { data: NonNullable<ReportPdfData["timeByClient"]> }) {
  const totalBillable = data.reduce((sum, row) => sum + row.billableHours, 0);
  const totalUnbillable = data.reduce((sum, row) => sum + row.unbillableHours, 0);
  const totalAmount = data.reduce((sum, row) => sum + row.amount, 0);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Time by Client</Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <View style={styles.colClient}>
            <Text style={styles.tableHeaderText}>Client</Text>
          </View>
          <View style={styles.colBillable}>
            <Text style={styles.tableHeaderText}>Billable</Text>
          </View>
          <View style={styles.colUnbillable}>
            <Text style={styles.tableHeaderText}>Unbillable</Text>
          </View>
          <View style={styles.colAmount}>
            <Text style={styles.tableHeaderText}>Amount</Text>
          </View>
        </View>

        {data.map((row, i) => (
          <View key={row.name} style={i % 2 === 1 ? styles.tableRowAlt : styles.tableRow}>
            <View style={styles.colClient}>
              <Text style={styles.cellBold}>{row.name}</Text>
            </View>
            <View style={styles.colBillable}>
              <Text style={styles.cellText}>{formatHours(row.billableHours)}</Text>
            </View>
            <View style={styles.colUnbillable}>
              <Text style={styles.cellText}>{formatHours(row.unbillableHours)}</Text>
            </View>
            <View style={styles.colAmount}>
              <Text style={styles.cellText}>{formatCurrency(row.amount)}</Text>
            </View>
          </View>
        ))}

        <View style={styles.totalsRow}>
          <View style={styles.colClient}>
            <Text style={styles.cellBold}>Total</Text>
          </View>
          <View style={styles.colBillable}>
            <Text style={styles.cellBold}>{formatHours(totalBillable)}</Text>
          </View>
          <View style={styles.colUnbillable}>
            <Text style={styles.cellBold}>{formatHours(totalUnbillable)}</Text>
          </View>
          <View style={styles.colAmount}>
            <Text style={styles.cellBold}>{formatCurrency(totalAmount)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function ExpensesByCategory({ data }: { data: NonNullable<ReportPdfData["expensesByCategory"]> }) {
  const total = data.reduce((sum, row) => sum + row.amount, 0);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Expenses by Category</Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <View style={styles.colCategory}>
            <Text style={styles.tableHeaderText}>Category</Text>
          </View>
          <View style={styles.colCategoryAmount}>
            <Text style={styles.tableHeaderText}>Amount</Text>
          </View>
        </View>

        {data.map((row, i) => (
          <View key={row.category} style={i % 2 === 1 ? styles.tableRowAlt : styles.tableRow}>
            <View style={styles.colCategory}>
              <Text style={styles.cellText}>{row.category}</Text>
            </View>
            <View style={styles.colCategoryAmount}>
              <Text style={styles.cellText}>{formatCurrency(row.amount)}</Text>
            </View>
          </View>
        ))}

        <View style={styles.totalsRow}>
          <View style={styles.colCategory}>
            <Text style={styles.cellBold}>Total</Text>
          </View>
          <View style={styles.colCategoryAmount}>
            <Text style={styles.cellBold}>{formatCurrency(total)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function InvoiceStatus({ data }: { data: NonNullable<ReportPdfData["invoiceStatus"]> }) {
  const items = [
    { label: "Paid", value: data.paid },
    { label: "Pending", value: data.pending },
    { label: "Overdue", value: data.overdue },
    { label: "Draft", value: data.draft },
  ];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Invoice Status</Text>
      <View style={styles.statusGrid}>
        {items.map((item) => (
          <View key={item.label} style={styles.statusCell}>
            <Text style={styles.statusLabel}>{item.label}</Text>
            <Text style={styles.statusValue}>{formatCurrency(item.value)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function AccountingByMonth({ data }: { data: NonNullable<ReportPdfData["accountingMonths"]> }) {
  const totalIncome = data.reduce((sum, row) => sum + row.income, 0);
  const totalExpenses = data.reduce((sum, row) => sum + row.expenses, 0);
  const totalProfit = data.reduce((sum, row) => sum + row.profit, 0);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Accounting by Month</Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <View style={styles.colMonth}>
            <Text style={styles.tableHeaderText}>Month</Text>
          </View>
          <View style={styles.colIncome}>
            <Text style={styles.tableHeaderText}>Income</Text>
          </View>
          <View style={styles.colExpenses}>
            <Text style={styles.tableHeaderText}>Expenses</Text>
          </View>
          <View style={styles.colProfit}>
            <Text style={styles.tableHeaderText}>Profit</Text>
          </View>
        </View>

        {data.map((row, i) => (
          <View key={row.month} style={i % 2 === 1 ? styles.tableRowAlt : styles.tableRow}>
            <View style={styles.colMonth}>
              <Text style={styles.cellBold}>{row.month}</Text>
            </View>
            <View style={styles.colIncome}>
              <Text style={styles.cellText}>{formatCurrency(row.income)}</Text>
            </View>
            <View style={styles.colExpenses}>
              <Text style={styles.cellText}>{formatCurrency(row.expenses)}</Text>
            </View>
            <View style={styles.colProfit}>
              <Text style={styles.cellText}>{formatCurrency(row.profit)}</Text>
            </View>
          </View>
        ))}

        <View style={styles.totalsRow}>
          <View style={styles.colMonth}>
            <Text style={styles.cellBold}>Total</Text>
          </View>
          <View style={styles.colIncome}>
            <Text style={styles.cellBold}>{formatCurrency(totalIncome)}</Text>
          </View>
          <View style={styles.colExpenses}>
            <Text style={styles.cellBold}>{formatCurrency(totalExpenses)}</Text>
          </View>
          <View style={styles.colProfit}>
            <Text style={styles.cellBold}>{formatCurrency(totalProfit)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// Main component
function ReportPdfTemplate({ data }: { data: ReportPdfData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.orgName}>{data.organizationName}</Text>
          <Text style={styles.title}>{data.reportTitle}</Text>
          <Text style={styles.dateRange}>{data.dateRange}</Text>
          <Text style={styles.generatedAt}>Generated on {data.generatedAt}</Text>
        </View>

        {/* Conditional sections */}
        {data.financial && <FinancialSummary data={data.financial} />}
        {data.timeByClient && data.timeByClient.length > 0 && (
          <TimeByClient data={data.timeByClient} />
        )}
        {data.expensesByCategory && data.expensesByCategory.length > 0 && (
          <ExpensesByCategory data={data.expensesByCategory} />
        )}
        {data.invoiceStatus && <InvoiceStatus data={data.invoiceStatus} />}
        {data.accountingMonths && data.accountingMonths.length > 0 && (
          <AccountingByMonth data={data.accountingMonths} />
        )}

        {/* Footer */}
        <Text style={styles.footer}>
          {data.organizationName} — {data.reportTitle}
        </Text>
      </Page>
    </Document>
  );
}

export { ReportPdfTemplate, formatCurrency, formatHours };
export type { ReportPdfData };
