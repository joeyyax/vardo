import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import { htmlToPdfElements } from "./html-to-pdf";

export type DocumentPdfData = {
  title: string;
  sections: Array<{ title: string; content: string; visible: boolean }>;
  organizationName: string;
};

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
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#111827",
    marginBottom: 6,
  },
  orgName: {
    fontSize: 11,
    color: "#6b7280",
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
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

export function DocumentPdfTemplate({ data }: { data: DocumentPdfData }) {
  const visibleSections = data.sections.filter((s) => s.visible);

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>{data.title || "Untitled Document"}</Text>
          <Text style={styles.orgName}>{data.organizationName}</Text>
        </View>

        {/* Sections */}
        {visibleSections.map((section, index) => (
          <View key={index} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View>{htmlToPdfElements(section.content)}</View>
          </View>
        ))}

        {/* Footer */}
        <Text style={styles.footer}>
          {data.organizationName}
        </Text>
      </Page>
    </Document>
  );
}
