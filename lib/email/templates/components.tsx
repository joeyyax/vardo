import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Text,
} from "react-email";
import type { CSSProperties, ReactNode } from "react";

declare module "react" {
  interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
    bgcolor?: string;
  }
}

const FONT =
  "ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** Light colors inline, dark colors from the `<style>` block. */
export const PALETTE = {
  light: {
    background: "#f4f4f5",
    card: "#ffffff",
    foreground: "#18181b",
    soft: "#3f3f46",
    muted: "#71717a",
    border: "#e4e4e7",
    primary: "#18181b",
    onPrimary: "#ffffff",
    code: "#f4f4f5",
    codeText: "#27272a",
    success: "#15803d",
    successSoft: "#dcfce7",
    warn: "#b45309",
    warnSoft: "#fef3c7",
    fail: "#b91c1c",
    failSoft: "#fee2e2",
    info: "#1d4ed8",
    infoSoft: "#dbeafe",
  },
  dark: {
    background: "#09090b",
    card: "#18181b",
    foreground: "#fafafa",
    soft: "#d4d4d8",
    muted: "#a1a1aa",
    border: "#27272a",
    primary: "#fafafa",
    onPrimary: "#09090b",
    code: "#09090b",
    codeText: "#e4e4e7",
    success: "#4ade80",
    successSoft: "#052e16",
    warn: "#fbbf24",
    warnSoft: "#422006",
    fail: "#f87171",
    failSoft: "#450a0a",
    info: "#93c5fd",
    infoSoft: "#172554",
  },
} as const;

const { light, dark } = PALETTE;

export type MailTone = "success" | "warn" | "fail" | "info";

export type MailFact = {
  label: string;
  value: string;
  href?: string;
  mono?: boolean;
};

export type MailLink = { label: string; href: string };

export type MailFooter = {
  instanceName: string;
  orgName?: string;
  settingsUrl: string;
};

/** Everything a notification email shows. The HTML and plain-text parts both render from it. */
export type NotificationMailBody = {
  tone: MailTone;
  /** Badge text: "Deployed", "Failed", "Warning". */
  status: string;
  heading: string;
  /** Inbox preview line. Defaults to the first paragraph. */
  preheader?: string;
  paragraphs?: string[];
  facts?: MailFact[];
  /** Extra fact tables under their own titles. */
  sections?: { title: string; facts: MailFact[] }[];
  log?: { title: string; lines: string[] };
  /** A command to run, shown in a code block. */
  command?: { title: string; text: string };
  /** Charts, shown before the facts. */
  visuals?: MailVisual[];
  action?: MailLink;
  links?: MailLink[];
  footer: MailFooter;
};

/** Neutral shades by index, or a status color. */
export type ChartTone = 0 | 1 | 2 | 3 | "success" | "warn" | "fail";

export type ChartSegment = { label: string; value: number; tone?: ChartTone; detail?: string };

/** One column: parts stack bottom up. */
export type ChartColumn = { parts: { value: number; tone?: ChartTone }[]; label?: string };

export type MailVisual =
  | { kind: "stacked"; title: string; segments: ChartSegment[]; caption?: string }
  | { kind: "gauge"; title: string; percent: number; warn: number; critical: number; caption?: string }
  | {
      kind: "columns";
      title: string;
      columns: ChartColumn[];
      /** Under the first and last column. */
      axis?: [string, string];
      legend?: { label: string; tone: ChartTone }[];
      caption?: string;
    };

const TONE_COLOR: Record<MailTone, { fg: string; bg: string }> = {
  success: { fg: light.success, bg: light.successSoft },
  warn: { fg: light.warn, bg: light.warnSoft },
  fail: { fg: light.fail, bg: light.failSoft },
  info: { fg: light.info, bg: light.infoSoft },
};

const TONE_MARK: Record<MailTone, string> = { success: "✓", warn: "!", fail: "✗", info: "·" };

/** Neutral chart shades, darkest first; dark mode runs lightest first. */
const CHART_LIGHT = ["#3f3f46", "#71717a", "#a1a1aa", "#d4d4d8"] as const;
const CHART_DARK = ["#e4e4e7", "#a1a1aa", "#71717a", "#52525b"] as const;

function chartFill(tone: ChartTone = 0): { color: string; className: string } {
  if (typeof tone === "number") return { color: CHART_LIGHT[tone], className: `vd-fill-${tone}` };
  return { color: light[tone], className: `vd-fill-${tone}` };
}

const STYLE = `
body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (max-width:600px){.vd-card{padding:24px !important}.vd-outer{padding:24px 12px !important}}
@media (prefers-color-scheme:dark){
.vd-bg{background:${dark.background} !important}
.vd-card{background:${dark.card} !important;border-color:${dark.border} !important}
.vd-fg{color:${dark.foreground} !important}
.vd-soft{color:${dark.soft} !important}
.vd-muted{color:${dark.muted} !important}
.vd-rule{border-color:${dark.border} !important}
.vd-btn{background:${dark.primary} !important}
.vd-btn a{color:${dark.onPrimary} !important}
.vd-link{color:${dark.foreground} !important}
.vd-code{background:${dark.code} !important;color:${dark.codeText} !important;border-color:${dark.border} !important}
.vd-badge-success{background:${dark.successSoft} !important;color:${dark.success} !important}
.vd-badge-warn{background:${dark.warnSoft} !important;color:${dark.warn} !important}
.vd-badge-fail{background:${dark.failSoft} !important;color:${dark.fail} !important}
.vd-badge-info{background:${dark.infoSoft} !important;color:${dark.info} !important}
.vd-track{background:${dark.border} !important}
.vd-fill-0{background:${CHART_DARK[0]} !important}
.vd-fill-1{background:${CHART_DARK[1]} !important}
.vd-fill-2{background:${CHART_DARK[2]} !important}
.vd-fill-3{background:${CHART_DARK[3]} !important}
.vd-fill-success{background:${dark.success} !important}
.vd-fill-warn{background:${dark.warn} !important}
.vd-fill-fail{background:${dark.fail} !important}
.vd-tick{border-color:${dark.muted} !important}
}
[data-ogsc] .vd-fg{color:${dark.foreground} !important}
[data-ogsc] .vd-soft{color:${dark.soft} !important}
[data-ogsc] .vd-muted{color:${dark.muted} !important}
[data-ogsc] .vd-link{color:${dark.foreground} !important}
`;

const text = (size: number, color: string, extra: CSSProperties = {}): CSSProperties => ({
  margin: 0,
  fontFamily: FONT,
  fontSize: `${size}px`,
  lineHeight: 1.55,
  color,
  ...extra,
});

/** Layout table: no spacing, no semantics. */
function Table({ children, ...props }: { children: ReactNode; width?: string; style?: CSSProperties; className?: string }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} {...props}>
      <tbody>{children}</tbody>
    </table>
  );
}

export function MailHeader({ instanceName }: { instanceName: string }) {
  return (
    <p className="vd-fg" style={text(15, light.foreground, { fontWeight: 600, padding: "0 4px 16px" })}>
      Vardo
      <span className="vd-muted" style={{ color: light.muted, fontWeight: 400 }}>
        {` · ${instanceName}`}
      </span>
    </p>
  );
}

export function StatusBadge({ tone, children }: { tone: MailTone; children: string }) {
  const { fg, bg } = TONE_COLOR[tone];
  return (
    <span
      className={`vd-badge-${tone}`}
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: "999px",
        background: bg,
        color: fg,
        fontFamily: FONT,
        fontSize: "12px",
        fontWeight: 600,
        lineHeight: "18px",
      }}
    >
      {`${TONE_MARK[tone]} ${children}`}
    </span>
  );
}

export function FactsTable({ facts }: { facts: MailFact[] }) {
  const rule = `1px solid ${light.border}`;
  return (
    <Table width="100%" style={{ margin: "0 0 20px" }}>
      {facts.map((fact, index) => (
        <tr key={index}>
          <td
            className="vd-muted vd-rule"
            valign="top"
            style={text(14, light.muted, { padding: "8px 16px 8px 0", borderTop: rule, whiteSpace: "nowrap", width: "1%" })}
          >
            {fact.label}
          </td>
          <td
            className="vd-fg vd-rule"
            style={text(14, light.foreground, {
              padding: "8px 0",
              borderTop: rule,
              wordBreak: "break-word",
              ...(fact.mono ? { fontFamily: MONO, fontSize: "13px" } : {}),
            })}
          >
            {fact.href ? (
              <Link className="vd-link" href={fact.href} style={{ color: light.foreground, textDecoration: "underline" }}>
                {fact.value}
              </Link>
            ) : (
              fact.value
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Lines kept in a log block. */
export const LOG_MAX_LINES = 20;
const LOG_MAX_CHARS = 240;

/** The last lines of a log, each cut to a readable width. */
export function capLogLines(lines: string[], max = LOG_MAX_LINES): string[] {
  return lines
    .filter((line) => line.trim() !== "")
    .slice(-max)
    .map((line) => (line.length > LOG_MAX_CHARS ? `${line.slice(0, LOG_MAX_CHARS - 1)}…` : line));
}

export function CodeBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div style={{ margin: "0 0 20px" }}>
      <p className="vd-fg" style={text(14, light.foreground, { fontWeight: 600, margin: "0 0 8px" })}>
        {title}
      </p>
      <pre
        className="vd-code"
        style={{
          margin: 0,
          padding: "12px 14px",
          background: light.code,
          color: light.codeText,
          border: `1px solid ${light.border}`,
          borderRadius: "8px",
          fontFamily: MONO,
          fontSize: "12px",
          lineHeight: "18px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {lines.join("\n")}
      </pre>
    </div>
  );
}

export function LogBlock({ title, lines }: { title: string; lines: string[] }) {
  const capped = capLogLines(lines);
  if (capped.length === 0) return null;
  return <CodeBlock title={title} lines={capped} />;
}

export function PrimaryButton({ href, children }: { href: string; children: string }) {
  return (
    <Table style={{ margin: "4px 0 0" }}>
      <tr>
        <td className="vd-btn" style={{ borderRadius: "8px", background: light.primary }}>
          <Link
            href={href}
            style={{
              display: "inline-block",
              padding: "11px 20px",
              fontFamily: FONT,
              fontSize: "14px",
              fontWeight: 600,
              lineHeight: "18px",
              color: light.onPrimary,
              textDecoration: "none",
              borderRadius: "8px",
            }}
          >
            {children}
          </Link>
        </td>
      </tr>
    </Table>
  );
}

export function SecondaryLinks({ links }: { links: MailLink[] }) {
  if (links.length === 0) return null;
  return (
    <p className="vd-muted" style={text(14, light.muted, { margin: "14px 0 0" })}>
      {links.map((link, index) => (
        <span key={index}>
          {index > 0 ? "  ·  " : null}
          <Link className="vd-link" href={link.href} style={{ color: light.soft, textDecoration: "underline" }}>
            {link.label}
          </Link>
        </span>
      ))}
    </p>
  );
}

export function MailFooterBlock({ footer }: { footer: MailFooter }) {
  const scope = footer.orgName ? `${footer.orgName} on ${footer.instanceName}` : footer.instanceName;
  return (
    <p className="vd-muted" style={text(12, light.muted, { padding: "16px 4px 0", lineHeight: 1.5 })}>
      {`Sent by Vardo for ${scope}. `}
      <Link className="vd-link" href={footer.settingsUrl} style={{ color: light.muted, textDecoration: "underline" }}>
        Notification settings
      </Link>
    </p>
  );
}

// Charts: table cells only, so Gmail, Apple Mail and Outlook draw them the same.

const NBSP = " ";
const CELL_RESET: CSSProperties = { fontSize: 0, lineHeight: 0, padding: 0 };

function ChartTitle({ title }: { title: string }) {
  return (
    <p className="vd-fg" style={text(14, light.foreground, { fontWeight: 600, margin: "0 0 8px" })}>
      {title}
    </p>
  );
}

function ChartCaption({ caption }: { caption?: string }) {
  if (!caption) return null;
  return (
    <p className="vd-muted" style={text(12, light.muted, { margin: "6px 0 0" })}>
      {caption}
    </p>
  );
}

/** Whole-number percents that add up to 100, each segment at least 1. */
export function percentages(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const floored = raw.map((r) => (r > 0 ? Math.max(1, Math.floor(r)) : 0));
  let rest = 100 - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest === 0) break;
    if (floored[i] === 0) continue;
    const step = rest > 0 ? 1 : -1;
    if (floored[i] + step < 1) continue;
    floored[i] += step;
    rest -= step;
  }
  return floored;
}

/** A horizontal bar split into labelled segments, with a legend under it. */
export function StackedBar({ title, segments, caption }: { title: string; segments: ChartSegment[]; caption?: string }) {
  const shown = segments.filter((s) => s.value > 0);
  const pct = percentages(shown.map((s) => s.value));
  if (shown.length === 0) return null;
  return (
    <div style={{ margin: "0 0 20px" }}>
      <ChartTitle title={title} />
      <Table width="100%" style={{ tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }}>
        <tr>
          {shown.map((s, i) => {
            const fill = chartFill(s.tone ?? ((i % 4) as ChartTone));
            return (
              <td
                key={i}
                className={fill.className}
                width={`${pct[i]}%`}
                height="10"
                bgcolor={fill.color}
                style={{ ...CELL_RESET, width: `${pct[i]}%`, height: "10px", background: fill.color, borderRight: i < shown.length - 1 ? `2px solid ${light.card}` : undefined }}
              >
                {NBSP}
              </td>
            );
          })}
        </tr>
      </Table>
      <Table style={{ margin: "8px 0 0" }}>
        {shown.map((s, i) => {
          const fill = chartFill(s.tone ?? ((i % 4) as ChartTone));
          return (
            <tr key={i}>
              <td width="10" style={{ ...CELL_RESET, width: "10px", padding: "4px 8px 4px 0", verticalAlign: "middle" }}>
                <Table>
                  <tr>
                    <td className={fill.className} width="8" height="8" bgcolor={fill.color} style={{ ...CELL_RESET, width: "8px", height: "8px", background: fill.color, borderRadius: "2px" }}>
                      {NBSP}
                    </td>
                  </tr>
                </Table>
              </td>
              <td className="vd-soft" style={text(13, light.soft, { padding: "2px 12px 2px 0" })}>
                {s.label}
              </td>
              <td className="vd-muted" align="right" style={text(13, light.muted, { padding: "2px 0", whiteSpace: "nowrap" })}>
                {`${s.detail ? `${s.detail} · ` : ""}${pct[i]}%`}
              </td>
            </tr>
          );
        })}
      </Table>
      <ChartCaption caption={caption} />
    </div>
  );
}

function gaugeTone(percent: number, warn: number, critical: number): ChartTone {
  return percent >= critical ? "fail" : percent >= warn ? "warn" : "success";
}

/** A bar filled to `percent`, with ticks at the warning and critical thresholds. */
export function GaugeBar({ title, percent, warn, critical, caption }: { title: string; percent: number; warn: number; critical: number; caption?: string }) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const fill = chartFill(gaugeTone(percent, warn, critical));
  const ticks = [warn, critical].filter((t) => t > 0 && t < 100).sort((a, b) => a - b);
  const spans = ticks.map((t, i) => t - (i === 0 ? 0 : ticks[i - 1]));
  return (
    <div style={{ margin: "0 0 20px" }}>
      <ChartTitle title={`${title}: ${value}%`} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {value > 0 ? (
            <td className={fill.className} width={`${value}%`} height="12" bgcolor={fill.color} style={{ ...CELL_RESET, width: `${value}%`, height: "12px", background: fill.color }}>
              {NBSP}
            </td>
          ) : null}
          {value < 100 ? (
            <td className="vd-track" height="12" bgcolor={light.code} style={{ ...CELL_RESET, height: "12px", background: light.code }}>
              {NBSP}
            </td>
          ) : null}
        </tr>
      </Table>
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {spans.map((span, i) => (
            <td
              key={i}
              width={`${span}%`}
              align="right"
              className="vd-tick vd-muted"
              style={text(11, light.muted, { width: `${span}%`, padding: "3px 4px 0 0", borderRight: `1px solid ${light.muted}`, textAlign: "right" })}
            >
              {`${ticks[i]}%`}
            </td>
          ))}
          <td style={{ ...CELL_RESET }}>{NBSP}</td>
        </tr>
      </Table>
      <ChartCaption caption={caption} />
    </div>
  );
}

const COLUMN_HEIGHT = 56;

/** Columns of stacked parts; each is a fixed-height table whose spacer row takes what the bar doesn't. */
export function ColumnChart({ title, columns, axis, legend, caption }: Extract<MailVisual, { kind: "columns" }>) {
  const totals = columns.map((c) => c.parts.reduce((sum, p) => sum + Math.max(0, p.value), 0));
  const max = Math.max(1, ...totals);
  if (columns.length === 0) return null;
  // Few columns stay narrow instead of stretching into blocks.
  const width = `${Math.min(100, Math.max(48, columns.length * 8))}%`;
  return (
    <div style={{ margin: "0 0 20px" }}>
      <ChartTitle title={title} />
      <Table width={width} style={{ tableLayout: "fixed", width }}>
        <tr>
          {columns.map((column, i) => {
            const heights = column.parts.map((p) => (p.value > 0 ? Math.max(2, Math.round((p.value / max) * COLUMN_HEIGHT)) : 0));
            const used = Math.min(COLUMN_HEIGHT, heights.reduce((a, b) => a + b, 0));
            return (
              <td key={i} valign="bottom" style={{ ...CELL_RESET, padding: "0 2px", verticalAlign: "bottom" }}>
                <Table width="100%">
                  {COLUMN_HEIGHT - used > 0 ? (
                    <tr>
                      <td height={String(COLUMN_HEIGHT - used)} style={{ ...CELL_RESET, height: `${COLUMN_HEIGHT - used}px` }}>
                        {NBSP}
                      </td>
                    </tr>
                  ) : null}
                  {column.parts
                    .map((part, j) => ({ part, h: heights[j] }))
                    .reverse()
                    .filter(({ h }) => h > 0)
                    .map(({ part, h }, j) => {
                      const fill = chartFill(part.tone ?? 1);
                      return (
                        <tr key={j}>
                          <td className={fill.className} height={String(h)} bgcolor={fill.color} style={{ ...CELL_RESET, height: `${h}px`, background: fill.color }}>
                            {NBSP}
                          </td>
                        </tr>
                      );
                    })}
                  {used === 0 ? (
                    <tr>
                      <td className="vd-track" height="1" bgcolor={light.border} style={{ ...CELL_RESET, height: "1px", background: light.border }}>
                        {NBSP}
                      </td>
                    </tr>
                  ) : null}
                </Table>
              </td>
            );
          })}
        </tr>
        {columns.some((c) => c.label) ? (
          <tr>
            {columns.map((c, i) => (
              <td key={i} className="vd-muted" align="center" style={text(11, light.muted, { padding: "4px 0 0", textAlign: "center" })}>
                {c.label ?? NBSP}
              </td>
            ))}
          </tr>
        ) : null}
      </Table>
      {axis ? (
        <Table width={width} style={{ width }}>
          <tr>
            <td className="vd-muted" style={text(11, light.muted, { padding: "4px 0 0" })}>
              {axis[0]}
            </td>
            <td className="vd-muted" align="right" style={text(11, light.muted, { padding: "4px 0 0", textAlign: "right" })}>
              {axis[1]}
            </td>
          </tr>
        </Table>
      ) : null}
      {legend?.length ? (
        <p className="vd-muted" style={text(12, light.muted, { margin: "6px 0 0" })}>
          {legend.map((item, i) => {
            const fill = chartFill(item.tone);
            return (
              <span key={i}>
                {i > 0 ? "   " : null}
                <span className={fill.className} style={{ display: "inline-block", width: "8px", height: "8px", background: fill.color, borderRadius: "2px" }}>
                  {NBSP}
                </span>
                {` ${item.label}`}
              </span>
            );
          })}
        </p>
      ) : null}
      <ChartCaption caption={caption} />
    </div>
  );
}

export function Visual({ visual }: { visual: MailVisual }) {
  switch (visual.kind) {
    case "stacked":
      return <StackedBar {...visual} />;
    case "gauge":
      return <GaugeBar {...visual} />;
    case "columns":
      return <ColumnChart {...visual} />;
  }
}

const SPARK = "▁▂▃▄▅▆▇█";

/** ▁▂▃▅▇ from a series, scaled from zero like the HTML columns. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  return values.map((v) => SPARK[max <= 0 ? 0 : Math.round((Math.max(0, v) / max) * (SPARK.length - 1))]).join("");
}

/** The plain-text equivalent of a chart. */
export function visualText(visual: MailVisual): string {
  switch (visual.kind) {
    case "stacked": {
      const shown = visual.segments.filter((s) => s.value > 0);
      const pct = percentages(shown.map((s) => s.value));
      const line = shown.map((s, i) => `${s.label} ${pct[i]}%${s.tone === "fail" ? " ✗" : ""}`).join(" · ");
      return [visual.title, line, visual.caption].filter(Boolean).join("\n");
    }
    case "gauge": {
      const filled = Math.round(Math.max(0, Math.min(100, visual.percent)) / 5);
      const bar = `[${"#".repeat(filled)}${"-".repeat(20 - filled)}]`;
      return [`${visual.title}: ${Math.round(visual.percent)}% ${bar} (warn ${visual.warn}%, critical ${visual.critical}%)`, visual.caption].filter(Boolean).join("\n");
    }
    case "columns": {
      const totals = visual.columns.map((c) => c.parts.reduce((sum, p) => sum + p.value, 0));
      const axis = visual.axis ? ` (${visual.axis[0]} → ${visual.axis[1]})` : "";
      return [`${visual.title}${axis}`, sparkline(totals), visual.caption].filter(Boolean).join("\n");
    }
  }
}

/** The layout every notification email renders through. */
export function NotificationMail(body: NotificationMailBody) {
  const preheader = body.preheader ?? body.paragraphs?.[0] ?? body.heading;
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{body.heading}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </Head>
      <Body className="vd-bg" style={{ margin: 0, padding: 0, background: light.background }}>
        <Preview>{preheader}</Preview>
        <Table width="100%" className="vd-bg" style={{ background: light.background }}>
          <tr>
            <td align="center" className="vd-outer" style={{ padding: "32px 16px" }}>
              <Table width="100%" style={{ maxWidth: "560px" }}>
                <tr>
                  <td>
                    <MailHeader instanceName={body.footer.instanceName} />
                  </td>
                </tr>
                <tr>
                  <td
                    className="vd-card"
                    style={{ background: light.card, border: `1px solid ${light.border}`, borderRadius: "12px", padding: "28px" }}
                  >
                    <StatusBadge tone={body.tone}>{body.status}</StatusBadge>
                    <h1 className="vd-fg" style={text(20, light.foreground, { margin: "12px 0 12px", fontWeight: 600, lineHeight: 1.3 })}>
                      {body.heading}
                    </h1>
                    {(body.paragraphs ?? []).map((paragraph, index) => (
                      <p key={index} className="vd-soft" style={text(15, light.soft, { margin: "0 0 14px" })}>
                        {paragraph}
                      </p>
                    ))}
                    {(body.visuals ?? []).map((visual, index) => (
                      <Visual key={index} visual={visual} />
                    ))}
                    {body.facts?.length ? <FactsTable facts={body.facts} /> : null}
                    {(body.sections ?? []).map((section, index) =>
                      section.facts.length ? (
                        <div key={index}>
                          <p className="vd-fg" style={text(14, light.foreground, { fontWeight: 600, margin: "0 0 4px" })}>
                            {section.title}
                          </p>
                          <FactsTable facts={section.facts} />
                        </div>
                      ) : null,
                    )}
                    {body.log ? <LogBlock title={body.log.title} lines={body.log.lines} /> : null}
                    {body.command ? <CodeBlock title={body.command.title} lines={[body.command.text]} /> : null}
                    {body.action ? <PrimaryButton href={body.action.href}>{body.action.label}</PrimaryButton> : null}
                    <SecondaryLinks links={body.links ?? []} />
                  </td>
                </tr>
                <tr>
                  <td>
                    <MailFooterBlock footer={body.footer} />
                  </td>
                </tr>
              </Table>
            </td>
          </tr>
        </Table>
      </Body>
    </Html>
  );
}

function factsText(facts: MailFact[]): string {
  return facts
    .map((f) => {
      const link = f.href && f.href !== f.value && f.href !== `https://${f.value}` ? ` <${f.href}>` : "";
      return `${f.label ? `${f.label}: ` : "  "}${f.value}${link}`;
    })
    .join("\n");
}

/** The plain-text part, from the same body the HTML renders. */
export function notificationMailText(body: NotificationMailBody): string {
  const blocks: string[] = [`[${TONE_MARK[body.tone]} ${body.status}] ${body.heading}`];
  blocks.push(...(body.paragraphs ?? []));
  for (const visual of body.visuals ?? []) blocks.push(visualText(visual));
  if (body.facts?.length) blocks.push(factsText(body.facts));
  for (const section of body.sections ?? []) {
    if (section.facts.length) blocks.push(`${section.title}\n${factsText(section.facts)}`);
  }
  if (body.log) {
    const lines = capLogLines(body.log.lines);
    if (lines.length) blocks.push(`${body.log.title}\n${lines.map((l) => `    ${l}`).join("\n")}`);
  }
  if (body.command) blocks.push(`${body.command.title}\n    ${body.command.text}`);
  const links = [...(body.action ? [body.action] : []), ...(body.links ?? [])];
  if (links.length) blocks.push(links.map((l) => `${l.label}: ${l.href}`).join("\n"));
  const scope = body.footer.orgName ? `${body.footer.orgName} on ${body.footer.instanceName}` : body.footer.instanceName;
  blocks.push(`--\nSent by Vardo for ${scope}.\nNotification settings: ${body.footer.settingsUrl}`);
  return blocks.join("\n\n") + "\n";
}

// Account emails (invite, magic link).

export function EmailLayout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: "#fafafa", fontFamily: FONT }}>
        <Container
          style={{
            maxWidth: "480px",
            margin: "40px auto",
            padding: "40px 32px",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
          }}
        >
          <Text style={{ fontSize: "16px", fontWeight: "600", color: "#1a1a1a", margin: "0 0 32px" }}>Vardo</Text>
          {children}
          <Hr style={{ borderColor: "#eeeeee", margin: "32px 0 24px" }} />
          <Text style={{ color: "#b0b0b0", fontSize: "12px", margin: "0" }}>Sent by Vardo</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function CTA({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: "#1a1a1a",
        color: "#ffffff",
        padding: "12px 24px",
        borderRadius: "6px",
        fontWeight: "500",
        fontSize: "14px",
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      {children}
    </Button>
  );
}

export const styles = {
  h1: { color: "#1a1a1a", fontSize: "22px", fontWeight: "600", margin: "0 0 12px", lineHeight: "1.3" } as CSSProperties,
  text: { color: "#333333", fontSize: "14px", lineHeight: "24px", margin: "0 0 16px" } as CSSProperties,
  muted: { color: "#888888", fontSize: "13px", lineHeight: "22px", margin: "0 0 16px" } as CSSProperties,
};
