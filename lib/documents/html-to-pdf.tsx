import React from "react";
import { Text, View, Link, StyleSheet } from "@react-pdf/renderer";

/**
 * Converts a known HTML subset (from markdownToHtml / TipTap) into react-pdf elements.
 * Not a full HTML parser — handles the limited output our template engine produces.
 */

const styles = StyleSheet.create({
  paragraph: {
    marginBottom: 6,
    fontSize: 10,
    lineHeight: 1.5,
    color: "#374151",
  },
  bold: {
    fontFamily: "Helvetica-Bold",
  },
  italic: {
    fontFamily: "Helvetica-Oblique",
  },
  h2: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    marginBottom: 8,
    marginTop: 12,
    color: "#111827",
  },
  h3: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
    marginTop: 10,
    color: "#111827",
  },
  h4: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
    marginTop: 8,
    color: "#111827",
  },
  h5: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
    marginTop: 6,
    color: "#111827",
  },
  h6: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    marginBottom: 4,
    marginTop: 6,
    color: "#111827",
  },
  listItem: {
    flexDirection: "row",
    marginBottom: 3,
    paddingLeft: 8,
  },
  listBullet: {
    width: 14,
    fontSize: 10,
    color: "#6b7280",
  },
  listContent: {
    flex: 1,
    fontSize: 10,
    lineHeight: 1.5,
    color: "#374151",
  },
  hr: {
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
    marginVertical: 10,
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: "#d1d5db",
    paddingLeft: 10,
    marginVertical: 6,
    marginLeft: 4,
  },
  link: {
    color: "#2563eb",
    textDecoration: "underline",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  tableCell: {
    flex: 1,
    padding: 6,
    fontSize: 9,
    color: "#374151",
  },
  tableHeaderCell: {
    flex: 1,
    padding: 6,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "#111827",
    backgroundColor: "#f9fafb",
  },
});

/**
 * Parse an HTML string into react-pdf elements.
 * Uses a simple tag-by-tag approach since we control the HTML output.
 */
export function htmlToPdfElements(html: string): React.ReactNode[] {
  if (!html || !html.trim()) return [];

  const elements: React.ReactNode[] = [];
  let key = 0;

  // Split into block-level elements
  const blocks = splitIntoBlocks(html);

  for (const block of blocks) {
    const tag = getBlockTag(block);
    const inner = getInnerHtml(block, tag);

    switch (tag) {
      case "h2":
        elements.push(<Text key={key++} style={styles.h2}>{parseInline(inner)}</Text>);
        break;
      case "h3":
        elements.push(<Text key={key++} style={styles.h3}>{parseInline(inner)}</Text>);
        break;
      case "h4":
        elements.push(<Text key={key++} style={styles.h4}>{parseInline(inner)}</Text>);
        break;
      case "h5":
        elements.push(<Text key={key++} style={styles.h5}>{parseInline(inner)}</Text>);
        break;
      case "h6":
        elements.push(<Text key={key++} style={styles.h6}>{parseInline(inner)}</Text>);
        break;
      case "p":
        elements.push(<Text key={key++} style={styles.paragraph}>{parseInline(inner)}</Text>);
        break;
      case "ul":
        elements.push(<View key={key++}>{parseList(inner, "ul")}</View>);
        break;
      case "ol":
        elements.push(<View key={key++}>{parseList(inner, "ol")}</View>);
        break;
      case "hr":
        elements.push(<View key={key++} style={styles.hr} />);
        break;
      case "blockquote":
        elements.push(
          <View key={key++} style={styles.blockquote}>
            {htmlToPdfElements(inner)}
          </View>
        );
        break;
      case "table":
        elements.push(<View key={key++}>{parseTable(inner)}</View>);
        break;
      default:
        // Plain text or unrecognized — render as paragraph
        if (block.trim()) {
          elements.push(
            <Text key={key++} style={styles.paragraph}>{parseInline(block)}</Text>
          );
        }
    }
  }

  return elements;
}

/** Split HTML into top-level block elements */
function splitIntoBlocks(html: string): string[] {
  const blocks: string[] = [];
  const blockTagList = "p|h[1-6]|ul|ol|hr|blockquote|table|div";
  const pattern = new RegExp(
    `(<(?:${blockTagList})(?:\\s[^>]*)?>[\\s\\S]*?</(?:${blockTagList})>|<hr\\s*/?>)`,
    "gi"
  );

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const between = html.slice(lastIndex, match.index).trim();
      if (between) blocks.push(between);
    }
    blocks.push(match[0]);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < html.length) {
    const trailing = html.slice(lastIndex).trim();
    if (trailing) blocks.push(trailing);
  }

  return blocks;
}

/** Get the opening tag name from a block */
function getBlockTag(block: string): string {
  const match = block.match(/^<(\w+)/);
  return match ? match[1].toLowerCase() : "";
}

/** Extract inner HTML from a block element */
function getInnerHtml(block: string, tag: string): string {
  if (!tag || tag === "hr") return "";
  const openPattern = new RegExp(`^<${tag}[^>]*>`, "i");
  const closePattern = new RegExp(`</${tag}>$`, "i");
  return block.replace(openPattern, "").replace(closePattern, "").trim();
}

/** Parse inline HTML (strong, em, a, br) into react-pdf Text children */
function parseInline(html: string): React.ReactNode[] {
  if (!html) return [];

  const nodes: React.ReactNode[] = [];
  let key = 0;

  // Replace <br> / <br/> with newline
  const normalized = html.replace(/<br\s*\/?>/gi, "\n");

  // Split on inline tags
  const pattern = /<(strong|b|em|i|a)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      const text = stripTags(normalized.slice(lastIndex, match.index));
      if (text) nodes.push(text);
    }

    const tagName = match[0].match(/^<(\w+)/)?.[1]?.toLowerCase() || "";
    const innerText = stripTags(
      match[0].replace(/^<[^>]+>/, "").replace(/<\/\w+>$/, "")
    );

    if (tagName === "strong" || tagName === "b") {
      nodes.push(<Text key={key++} style={styles.bold}>{innerText}</Text>);
    } else if (tagName === "em" || tagName === "i") {
      nodes.push(<Text key={key++} style={styles.italic}>{innerText}</Text>);
    } else if (tagName === "a") {
      const href = match[0].match(/href="([^"]*)"/)?.[1] || "";
      nodes.push(
        <Link key={key++} src={href} style={styles.link}>
          {innerText}
        </Link>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    const text = stripTags(normalized.slice(lastIndex));
    if (text) nodes.push(text);
  }

  return nodes.length > 0 ? nodes : [stripTags(normalized)];
}

/** Parse list items from inner HTML */
function parseList(inner: string, type: "ul" | "ol"): React.ReactNode[] {
  const items: React.ReactNode[] = [];
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  let index = 0;

  while ((match = liPattern.exec(inner)) !== null) {
    const bullet = type === "ul" ? "\u2022 " : `${index + 1}. `;
    items.push(
      <View key={index} style={styles.listItem}>
        <Text style={styles.listBullet}>{bullet}</Text>
        <Text style={styles.listContent}>{parseInline(match[1])}</Text>
      </View>
    );
    index++;
  }

  return items;
}

/** Parse a simple HTML table */
function parseTable(inner: string): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let rowIndex = 0;

  while ((match = trPattern.exec(inner)) !== null) {
    const rowHtml = match[1];
    const isHeader = /<th/i.test(rowHtml);
    const cellPattern = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    const cells: React.ReactNode[] = [];
    let cellMatch;
    let cellIndex = 0;

    while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
      cells.push(
        <Text
          key={cellIndex}
          style={isHeader ? styles.tableHeaderCell : styles.tableCell}
        >
          {stripTags(cellMatch[1])}
        </Text>
      );
      cellIndex++;
    }

    rows.push(
      <View key={rowIndex} style={styles.tableRow}>
        {cells}
      </View>
    );
    rowIndex++;
  }

  return rows;
}

/** Strip all HTML tags from a string */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
