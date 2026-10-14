import { Body, Button, Head, Html, Link, Preview } from "react-email";
import { Fragment, type CSSProperties, type ReactNode, type TableHTMLAttributes } from "react";
import { truncate } from "../format";

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
    background: "#ffffff",
    sunk: "#f4f4f5",
    foreground: "#18181b",
    soft: "#3f3f46",
    muted: "#71717a",
    border: "#e4e4e7",
    underline: "#a1a1aa",
    primary: "#18181b",
    onPrimary: "#ffffff",
    code: "#f4f4f5",
    codeText: "#3f3f46",
    success: "#16a34a",
    successText: "#15803d",
    successSoft: "#dcfce7",
    warn: "#d97706",
    warnText: "#b45309",
    warnSoft: "#fef3c7",
    warnTint: "#fffbeb",
    fail: "#dc2626",
    failText: "#b91c1c",
    failSoft: "#fee2e2",
    failTint: "#fef2f2",
    info: "#1d4ed8",
    infoSoft: "#dbeafe",
  },
  dark: {
    background: "#18181b",
    sunk: "#111113",
    foreground: "#fafafa",
    soft: "#d4d4d8",
    muted: "#a1a1aa",
    border: "#27272a",
    underline: "#52525b",
    primary: "#fafafa",
    onPrimary: "#09090b",
    code: "#111113",
    codeText: "#d4d4d8",
    success: "#4ade80",
    successText: "#4ade80",
    successSoft: "#052e16",
    warn: "#fbbf24",
    warnText: "#fbbf24",
    warnSoft: "#422006",
    warnTint: "#1f1608",
    fail: "#f87171",
    failText: "#f87171",
    failSoft: "#3b1212",
    failTint: "#1f0d0d",
    info: "#93c5fd",
    infoSoft: "#172554",
  },
} as const;

const { light, dark } = PALETTE;

/** Neutral ramp from faintest to strongest. */
const RAMP_LIGHT = ["#f4f4f5", "#e4e4e7", "#a1a1aa", "#52525b", "#18181b"] as const;
const RAMP_DARK = ["#1f1f23", "#27272a", "#52525b", "#a1a1aa", "#fafafa"] as const;
export type RampStep = 0 | 1 | 2 | 3 | 4;

export type MailTone = "success" | "warn" | "fail" | "info";

/** Inline content: plain text, a link, inline code or a chip. */
export type MailInline =
  | string
  | { text: string; href?: string; mono?: boolean; strong?: boolean }
  | { chip: string; new?: boolean };

/** A string, or runs of inline content. */
export type MailRich = string | MailInline[];

export type MailFact = {
  label: string;
  value: string;
  href?: string;
  /** Links the label, for a row named after an app. */
  labelHref?: string;
  mono?: boolean;
  /** Shown in place of `value` in the HTML part. */
  rich?: MailRich;
};

export type MailLink = { label: string; href: string };

export type MailFooter = {
  instanceName: string;
  /** Console host, e.g. vardo.example.com. */
  consoleHost?: string;
  /** Console origin; links the instance name in the brand line. */
  consoleUrl?: string;
  settingsUrl: string;
  /** Text before the footer links, e.g. "Next recap in 30 days." */
  note?: string;
  /** Replaces "Notification settings". */
  settingsLabel?: string;
};

/** Everything a notification email shows. The HTML and plain-text parts both render from it. */
export type NotificationMailBody = {
  tone: MailTone;
  /** Verdict text: "Deployed", "Failed", "Warning". The layout doesn't show it. */
  status: string;
  /** Glyph before the verdict. Defaults to the tone's; info has none. */
  mark?: string;
  heading: string;
  /** Inbox preview line. Defaults to the first paragraph. */
  preheader?: string;
  paragraphs?: string[];
  /** Kit blocks, after the paragraphs. */
  blocks?: MailBlock[];
  facts?: MailFact[];
  /** Secondary version and deployment facts. */
  details?: MailFact[];
  /** Extra fact tables under their own titles. */
  sections?: { title: string; facts: MailFact[] }[];
  log?: { title: string; lines: string[] };
  /** A command to run, shown in a code block. */
  command?: { title: string; text: string };
  /** Charts, shown before the facts. */
  visuals?: MailVisual[];
  action?: MailLink;
  /** Footer links, before Notification settings. */
  links?: MailLink[];
  footer: MailFooter;
};

/** Neutral shades by index, or a status color. */
export type ChartTone = NeutralTone | "success" | "warn" | "fail";
export type NeutralTone = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ChartSegment = { label: string; value: number; tone?: ChartTone; detail?: string };

/** One column: parts stack bottom up. */
export type ChartColumn = { parts: { value: number; tone?: ChartTone }[]; label?: string };

export type PhaseStep = { label: string; value: number; detail?: string; failed?: boolean };
export type DayState = "ok" | "fail" | "none";
export type VolumeRow = { name: string; size: string; change?: string; value: number; flag?: string };

export type MailVisual =
  | { kind: "stacked"; title?: string; segments: ChartSegment[]; caption?: string }
  | {
      kind: "gauge";
      title?: string;
      percent: number;
      warn: number;
      critical: number;
      /** Left of the label row, e.g. "204 of 223.4 GiB". Defaults to the percent. */
      label?: string;
      caption?: string;
    }
  | {
      kind: "columns";
      title?: string;
      columns: ChartColumn[];
      /** Under the first and last column. */
      axis?: [string, string];
      legend?: { label: string; tone: ChartTone }[];
      caption?: string;
      /** Short columns, for callouts. */
      compact?: boolean;
      /** "auto" trims the empty band under values that all sit high. */
      baseline?: "zero" | "auto";
    }
  | { kind: "phases"; title?: string; steps: PhaseStep[]; caption?: string }
  | {
      kind: "days";
      title?: string;
      days: DayState[];
      /** Legend words for ok and fail. */
      legend?: [string, string];
      /** After the legend, e.g. "30 of 30 ran". */
      summary?: string;
    }
  | { kind: "hours"; title?: string; values: number[] }
  | { kind: "volumes"; title?: string; rows: VolumeRow[]; caption?: string };

export type StatTile = {
  label: string;
  value: string;
  /** Small text after the value, verbatim: " GiB", "/6", "%". */
  unit?: string;
  sub?: string;
  /** Amber value. */
  hot?: boolean;
  /** Links the value and drops it to name size. */
  href?: string;
};

export type StatsCell = string | { value: string; sub?: string; hot?: boolean; spark?: number[] };
export type StatsColumn = string | { label: string; align?: "left" | "right"; width?: string };
export type StatsRow = {
  name: string;
  href?: string;
  sub?: string;
  /** Amber note under the name. */
  why?: MailRich;
  cells: StatsCell[];
};

export type TimelineStep = { label: string; date: string };

export type MailBlock =
  | MailVisual
  | { kind: "text"; text: MailRich }
  | { kind: "reassure"; strong: string; text?: MailRich }
  | {
      kind: "callout";
      tone: "warn" | "bad";
      title: MailRich;
      body?: MailRich;
      /** Shown under the body, e.g. a compact column chart. */
      visual?: MailVisual;
      action?: MailLink;
    }
  | { kind: "section"; title: MailRich }
  | { kind: "note"; text: MailRich }
  | { kind: "tiles"; tiles: StatTile[] }
  | { kind: "stats"; columns: StatsColumn[]; rows: StatsRow[]; footer?: MailRich }
  | { kind: "facts"; facts: MailFact[] }
  | { kind: "chips"; chips: { text: string; new?: boolean }[] }
  | { kind: "timeline"; steps: TimelineStep[]; current: number }
  | { kind: "log"; title?: string; lines: string[]; highlight?: number[] };

const TONE_COLOR: Record<MailTone, { fg: string; bg: string }> = {
  success: { fg: light.successText, bg: light.successSoft },
  warn: { fg: light.warnText, bg: light.warnSoft },
  fail: { fg: light.failText, bg: light.failSoft },
  info: { fg: light.info, bg: light.infoSoft },
};

const TONE_MARK: Record<MailTone, string> = { success: "✓", warn: "!", fail: "✗", info: "" };

/** "✓ Backed up", or the bare status when there's no glyph. */
export function badgeText(tone: MailTone, status: string, mark?: string): string {
  const glyph = mark ?? TONE_MARK[tone];
  return glyph ? `${glyph} ${status}` : status;
}

/** Neutral chart shades; dark mode inverts them. 4 to 6 fill the gaps for longer sequences. */
const CHART_LIGHT = ["#3f3f46", "#71717a", "#a1a1aa", "#d4d4d8", "#27272a", "#58585f", "#8b8b93"] as const;
const CHART_DARK = ["#e4e4e7", "#a1a1aa", "#71717a", "#52525b", "#fafafa", "#c4c4ca", "#8b8b93"] as const;

/** Neutral tones from strongest to faintest. */
export const NEUTRAL_RAMP: readonly NeutralTone[] = [4, 0, 5, 1, 6, 2, 3];

/** `count` neutral tones spread across the ramp, strongest first. */
export function rampTones(count: number): NeutralTone[] {
  const last = NEUTRAL_RAMP.length - 1;
  return Array.from({ length: count }, (_, i) => NEUTRAL_RAMP[count > 1 ? Math.round((i * last) / (count - 1)) : 0]);
}

type Fill = { color: string; className: string };

function chartFill(tone: ChartTone = 0): Fill {
  if (typeof tone === "number") return { color: CHART_LIGHT[tone], className: `vd-fill-${tone}` };
  return { color: light[tone], className: `vd-fill-${tone}` };
}

function rampFill(step: RampStep): Fill {
  return { color: RAMP_LIGHT[step], className: `vd-r${step}` };
}

/** Tile value sizes and what each drops to on a phone. */
const TILE_SIZES = [22, 20, 18, 16] as const;
const TILE_PHONE: Record<(typeof TILE_SIZES)[number], number> = { 22: 18, 20: 17, 18: 16, 16: 14 };

const STYLE = `
body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.vd-ln{text-underline-offset:2px}
@media (max-width:520px){.vd-outer{padding:20px 16px !important}}
@media (max-width:480px){
.vd-tile{padding:10px !important}
${TILE_SIZES.map((s) => `.vd-tv-${s}{font-size:${TILE_PHONE[s]}px !important;white-space:nowrap !important}`).join("\n")}
.vd-tu{font-size:11px !important}
.vd-tk,.vd-ts{font-size:11px !important}
.vd-tgap{width:6px !important}
}
@media (prefers-color-scheme:dark){
.vd-bg{background:${dark.background} !important}
.vd-sunk{background:${dark.sunk} !important}
.vd-fg{color:${dark.foreground} !important}
.vd-soft{color:${dark.soft} !important}
.vd-muted{color:${dark.muted} !important}
.vd-rule{border-color:${dark.border} !important}
.vd-btn{background:${dark.primary} !important}
.vd-btn a{color:${dark.onPrimary} !important}
.vd-link{color:${dark.foreground} !important}
.vd-ln{color:${dark.foreground} !important;text-decoration-color:${dark.underline} !important}
.vd-ln-soft{color:${dark.soft} !important}
.vd-ln-warn,.vd-warn-text{color:${dark.warnText} !important}
.vd-fail-text{color:${dark.failText} !important}
.vd-code{background:${dark.code} !important;color:${dark.codeText} !important;border-color:${dark.border} !important}
.vd-callout-warn{background:${dark.warnTint} !important;border-color:${dark.warnSoft} !important}
.vd-callout-bad{background:${dark.failTint} !important;border-color:${dark.failSoft} !important}
.vd-icon-warn{background:${dark.warn} !important;color:${dark.background} !important}
.vd-icon-bad{background:${dark.fail} !important;color:${dark.background} !important}
.vd-btn2{background:${dark.background} !important;border-color:${dark.border} !important;color:${dark.foreground} !important}
.vd-chip{background:${dark.sunk} !important;border-color:${dark.border} !important;color:${dark.foreground} !important}
.vd-chip-new{background:${dark.warnSoft} !important;border-color:${dark.warnSoft} !important;color:${dark.warnText} !important}
.vd-badge-success{background:${dark.successSoft} !important;color:${dark.success} !important}
.vd-badge-warn{background:${dark.warnSoft} !important;color:${dark.warn} !important}
.vd-badge-fail{background:${dark.failSoft} !important;color:${dark.fail} !important}
.vd-badge-info{background:${dark.infoSoft} !important;color:${dark.info} !important}
.vd-track{background:${RAMP_DARK[1]} !important}
${RAMP_DARK.map((c, i) => `.vd-r${i}{background:${c} !important}`).join("\n")}
.vd-dot-done{background:${RAMP_DARK[4]} !important;border-color:${RAMP_DARK[4]} !important}
.vd-dot-now{background:${dark.background} !important;border-color:${RAMP_DARK[4]} !important;box-shadow:0 0 0 3px ${RAMP_DARK[1]} !important}
.vd-dot-next{background:${dark.background} !important;border-color:${RAMP_DARK[2]} !important}
${CHART_DARK.map((c, i) => `.vd-fill-${i}{background:${c} !important}`).join("\n")}
.vd-fill-success{background:${dark.success} !important}
.vd-fill-warn{background:${dark.warn} !important}
.vd-fill-fail{background:${dark.fail} !important}
.vd-tick{border-color:${dark.muted} !important}
.vd-gap{border-color:${dark.background} !important}
}
[data-ogsc] .vd-fg,[data-ogsc] .vd-link,[data-ogsc] .vd-ln{color:${dark.foreground} !important}
[data-ogsc] .vd-soft,[data-ogsc] .vd-ln-soft{color:${dark.soft} !important}
[data-ogsc] .vd-muted{color:${dark.muted} !important}
[data-ogsc] .vd-warn-text,[data-ogsc] .vd-ln-warn{color:${dark.warnText} !important}
[data-ogsc] .vd-fail-text{color:${dark.failText} !important}
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
function Table({ children, ...props }: { children: ReactNode } & TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} {...props}>
      <tbody>{children}</tbody>
    </table>
  );
}

const NBSP = " ";
const CELL_RESET: CSSProperties = { fontSize: 0, lineHeight: 0, padding: 0 };

// Inline content.

type LinkTone = "fg" | "soft" | "warn";
const LINK_TONE: Record<LinkTone, { color: string; className: string }> = {
  fg: { color: light.foreground, className: "vd-ln" },
  soft: { color: light.soft, className: "vd-ln vd-ln-soft" },
  warn: { color: light.warnText, className: "vd-ln vd-ln-warn" },
};

/** An app, project or org name linked with a subtle underline. */
export function NameLink({ href, tone = "fg", children }: { href: string; tone?: LinkTone; children: ReactNode }) {
  const { color, className } = LINK_TONE[tone];
  return (
    <Link
      className={className}
      href={href}
      style={{ color, textDecoration: "underline", textDecorationColor: light.underline, textUnderlineOffset: "2px" }}
    >
      {children}
    </Link>
  );
}

/** A linked name as inline content. */
export function nameLink(text: string, href?: string): MailInline {
  return href ? { text, href } : text;
}

/** "a, b and c" with each name linked where it has an href. */
export function linkedList(items: { text: string; href?: string }[]): MailInline[] {
  const out: MailInline[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? " and " : ", ");
    out.push(nameLink(item.text, item.href));
  });
  return out;
}

export function Chip({ children, isNew }: { children: string; isNew?: boolean }) {
  return (
    <span
      className={isNew ? "vd-chip-new" : "vd-chip"}
      style={{
        display: "inline-block",
        fontFamily: MONO,
        fontSize: "12.5px",
        lineHeight: "18px",
        padding: "3px 9px",
        margin: "0 6px 6px 0",
        borderRadius: "6px",
        background: isNew ? light.warnSoft : light.sunk,
        border: `1px solid ${isNew ? light.warnSoft : light.border}`,
        color: isNew ? light.warnText : light.foreground,
        fontWeight: isNew ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Rich({ value, link = "fg" }: { value: MailRich; link?: LinkTone }) {
  if (typeof value === "string") return <>{value}</>;
  return (
    <>
      {value.map((part, i) => {
        if (typeof part === "string") return <span key={i}>{part}</span>;
        if ("chip" in part) return <Chip key={i} isNew={part.new}>{part.chip}</Chip>;
        let node: ReactNode = part.text;
        if (part.mono) node = <code style={{ fontFamily: MONO, fontSize: "0.9em" }}>{node}</code>;
        if (part.strong) node = <strong>{node}</strong>;
        return part.href ? (
          <NameLink key={i} href={part.href} tone={link}>
            {node}
          </NameLink>
        ) : (
          <span key={i}>{node}</span>
        );
      })}
    </>
  );
}

function chipText(chip: string, isNew?: boolean): string {
  return isNew && !/\bnew\b/i.test(chip) ? `${chip} (new)` : chip;
}

/** Inline content as plain text; links keep their label only. */
export function richText(value: MailRich): string {
  if (typeof value === "string") return value;
  return value
    .map((part) => (typeof part === "string" ? part : "chip" in part ? chipText(part.chip, part.new) : part.text))
    .join("");
}

// Layout pieces.

export function MailHeader({ instanceName, href }: { instanceName: string; href?: string }) {
  const instance = instanceName.trim();
  const named = instance && instance !== "Vardo";
  return (
    <p className="vd-fg" style={text(15, light.foreground, { fontWeight: 600 })}>
      {named ? (
        <>
          {href ? <NameLink href={href}>{instance}</NameLink> : instance}
          <span className="vd-muted" style={{ color: light.muted, fontWeight: 400 }}>
            {" · Vardo"}
          </span>
        </>
      ) : (
        "Vardo"
      )}
    </p>
  );
}

/** Verdict pill. The flat layout doesn't use it. */
export function StatusBadge({ tone, mark, children }: { tone: MailTone; mark?: string; children: string }) {
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
      {badgeText(tone, children, mark)}
    </span>
  );
}

export function Title({ children }: { children: string }) {
  return (
    <h1 className="vd-fg" style={text(22, light.foreground, { fontWeight: 700, lineHeight: 1.25 })}>
      {children}
    </h1>
  );
}

export function Lead({ text: value }: { text: MailRich }) {
  return (
    <p className="vd-soft" style={text(15, light.soft)}>
      <Rich value={value} link="soft" />
    </p>
  );
}

/** "Nothing is down. The previous version is still serving." */
export function Reassurance({ strong, text: rest }: { strong: string; text?: MailRich }) {
  return (
    <Table width="100%">
      <tr>
        <td className="vd-sunk vd-soft" bgcolor={light.sunk} style={text(14, light.soft, { padding: "10px 14px", background: light.sunk, borderRadius: "8px" })}>
          <strong className="vd-fg" style={{ color: light.foreground }}>
            {strong}
          </strong>
          {rest ? (
            <>
              {" "}
              <Rich value={rest} link="soft" />
            </>
          ) : null}
        </td>
      </tr>
    </Table>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p
      className="vd-muted"
      style={text(12, light.muted, { fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1.4 })}
    >
      {children}
    </p>
  );
}

export function Note({ text: value }: { text: MailRich }) {
  return (
    <p className="vd-muted" style={text(12, light.muted)}>
      <Rich value={value} link="soft" />
    </p>
  );
}

export function SmallButton({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="vd-btn2"
      style={{
        display: "inline-block",
        fontFamily: FONT,
        fontSize: "13px",
        fontWeight: 600,
        lineHeight: "18px",
        padding: "5px 11px",
        borderRadius: "6px",
        background: light.background,
        border: `1px solid ${light.border}`,
        color: light.foreground,
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

const CALLOUT = {
  warn: { bg: light.warnTint, border: light.warnSoft, icon: light.warn },
  bad: { bg: light.failTint, border: light.failSoft, icon: light.fail },
} as const;

/** A problem with its own action. No heading above it. */
export function Callout({ tone, title, body, visual, action }: Extract<MailBlock, { kind: "callout" }>) {
  const c = CALLOUT[tone];
  return (
    <Table
      width="100%"
      className={`vd-callout-${tone}`}
      style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: "10px", borderCollapse: "separate" }}
    >
      <tr>
        <td valign="top" width="22" style={{ padding: "14px 0 14px 16px", width: "22px", verticalAlign: "top" }}>
          <Table>
            <tr>
              <td
                className={`vd-icon-${tone}`}
                width="22"
                height="22"
                align="center"
                bgcolor={c.icon}
                style={{
                  width: "22px",
                  height: "22px",
                  borderRadius: "11px",
                  background: c.icon,
                  color: light.background,
                  fontFamily: FONT,
                  fontSize: "13px",
                  fontWeight: 700,
                  lineHeight: "22px",
                  textAlign: "center",
                }}
              >
                !
              </td>
            </tr>
          </Table>
        </td>
        <td valign="top" style={{ padding: "14px 16px", verticalAlign: "top" }}>
          <p className="vd-fg" style={text(15, light.foreground, { fontWeight: 600, margin: "0 0 2px", lineHeight: 1.4 })}>
            <Rich value={title} />
          </p>
          {body ? (
            <p className="vd-soft" style={text(14, light.soft, { margin: "0 0 8px" })}>
              <Rich value={body} link="soft" />
            </p>
          ) : null}
          {visual ? (
            <div style={{ margin: "4px 0 8px" }}>
              <Visual visual={visual} />
            </div>
          ) : null}
          {action ? <SmallButton href={action.href}>{action.label}</SmallButton> : null}
        </td>
      </tr>
    </Table>
  );
}

/** Rough rendered width of `chars` characters at `size`px. */
function textWidth(chars: number, size: number, em = 0.62): number {
  return chars * size * em;
}

/** Width a tile value gets on a 560px layout. */
export const TILE_VALUE_WIDTH = 140;

/** The largest tile size whose value and unit fit on one line. */
export function tileValueSize(value: string, unit = ""): (typeof TILE_SIZES)[number] {
  const unitWidth = textWidth(unit.length, 13, 0.58);
  return TILE_SIZES.find((size) => textWidth(value.length, size) + unitWidth <= TILE_VALUE_WIDTH) ?? 16;
}

function Tile({ tile }: { tile: StatTile }) {
  const size = tile.href ? 16 : tileValueSize(tile.value, tile.unit);
  const color = tile.hot ? light.warnText : light.foreground;
  return (
    <>
      <p className="vd-muted vd-tk" style={text(12, light.muted, { lineHeight: 1.4 })}>
        {tile.label}
      </p>
      <p
        className={`${tile.hot ? "vd-warn-text" : "vd-fg"} vd-tv-${size}`}
        style={text(size, color, { fontWeight: 650, lineHeight: 1.25, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" })}
      >
        {tile.href ? <NameLink href={tile.href}>{tile.value}</NameLink> : tile.value}
        {tile.unit ? (
          <span className="vd-muted vd-tu" style={{ fontSize: "13px", fontWeight: 500, color: light.muted, letterSpacing: 0 }}>
            {tile.unit}
          </span>
        ) : null}
      </p>
      {tile.sub ? (
        <p className="vd-muted vd-ts" style={text(12, light.muted, { margin: "2px 0 0", lineHeight: 1.4 })}>
          {tile.sub}
        </p>
      ) : null}
    </>
  );
}

/** Stat tiles, three to a row. */
export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  const rows: (StatTile | null)[][] = [];
  for (let i = 0; i < tiles.length; i += 3) {
    const row: (StatTile | null)[] = tiles.slice(i, i + 3);
    while (row.length < 3) row.push(null);
    rows.push(row);
  }
  return (
    <Table width="100%" style={{ tableLayout: "fixed", borderCollapse: "separate" }}>
      {rows.flatMap((row, r) => [
        r > 0 ? (
          <tr key={`gap-${r}`}>
            <td colSpan={5} height="8" style={{ ...CELL_RESET, height: "8px" }}>
              {NBSP}
            </td>
          </tr>
        ) : null,
        <tr key={r}>
          {row.flatMap((tile, i) => [
            i > 0 ? (
              <td key={`g${i}`} className="vd-tgap" width="8" style={{ ...CELL_RESET, width: "8px" }}>
                {NBSP}
              </td>
            ) : null,
            tile ? (
              <td
                key={i}
                className="vd-sunk vd-tile"
                valign="top"
                bgcolor={light.sunk}
                style={{ width: "33%", verticalAlign: "top", background: light.sunk, borderRadius: "10px", padding: "12px 14px" }}
              >
                <Tile tile={tile} />
              </td>
            ) : (
              <td key={i} style={{ width: "33%" }}>
                {NBSP}
              </td>
            ),
          ])}
        </tr>,
      ])}
    </Table>
  );
}

// Sparkline bars, shared by the column chart and stats cells.

type Bar = { parts: { h: number; fill: Fill }[] };

function Bars({ bars, height, pad = "0 1px", radius = true }: { bars: Bar[]; height: number; pad?: string; radius?: boolean }) {
  return (
    <Table width="100%" style={{ tableLayout: "fixed" }}>
      <tr>
        {bars.map((bar, i) => {
          const used = Math.min(height, bar.parts.reduce((a, p) => a + p.h, 0));
          const shown = bar.parts.filter((p) => p.h > 0).reverse();
          return (
            <td key={i} valign="bottom" style={{ ...CELL_RESET, padding: pad, verticalAlign: "bottom" }}>
              <Table width="100%">
                {height - used > 0 ? (
                  <tr>
                    <td height={String(height - used)} style={{ ...CELL_RESET, height: `${height - used}px` }}>
                      {NBSP}
                    </td>
                  </tr>
                ) : null}
                {shown.map((p, j) => (
                  <tr key={j}>
                    <td
                      className={p.fill.className}
                      height={String(p.h)}
                      bgcolor={p.fill.color}
                      style={{
                        ...CELL_RESET,
                        height: `${p.h}px`,
                        background: p.fill.color,
                        borderRadius: radius && j === 0 ? "2px 2px 0 0" : undefined,
                      }}
                    >
                      {NBSP}
                    </td>
                  </tr>
                ))}
              </Table>
            </td>
          );
        })}
      </tr>
    </Table>
  );
}

/** Peak-marked mini bars from `min` to `max`, for a stats cell. */
export function sparkHeights(values: number[], height = 22): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  return values.map((v) => Math.max(2, Math.round(4 + ((v - min) / Math.max(1, max - min)) * (height - 4))));
}

function MiniSpark({ values }: { values: number[] }) {
  const heights = sparkHeights(values);
  const peak = values.indexOf(Math.max(...values));
  return <Bars height={22} pad="0 1px 0 0" radius={false} bars={heights.map((h, i) => ({ parts: [{ h, fill: rampFill(i === peak ? 4 : 2) }] }))} />;
}

/** Name column plus right-aligned numbers. */
export function StatsTable({ columns, rows, footer }: Extract<MailBlock, { kind: "stats" }>) {
  const rule = `1px solid ${light.border}`;
  const cols = columns.map((c) => (typeof c === "string" ? { label: c } : c));
  return (
    <Table width="100%" style={{ fontVariantNumeric: "tabular-nums" }}>
      <tr>
        {cols.map((c, i) => {
          const align = c.align ?? (i === 0 ? "left" : "right");
          return (
            <td
              key={i}
              className="vd-muted"
              align={align}
              width={c.width}
              style={text(11.5, light.muted, { fontWeight: 600, textAlign: align, padding: i === 0 ? "0 0 8px" : "0 0 8px 10px", whiteSpace: "nowrap", width: c.width })}
            >
              {c.label}
            </td>
          );
        })}
      </tr>
      {rows.map((row, r) => (
        <tr key={r}>
          <td className="vd-fg vd-rule" valign="top" style={text(13.5, light.foreground, { padding: "9px 0", borderTop: rule, verticalAlign: "top" })}>
            <span style={{ fontWeight: 600 }}>{row.href ? <NameLink href={row.href}>{row.name}</NameLink> : row.name}</span>
            {row.sub ? (
              <span className="vd-muted" style={{ display: "block", fontSize: "11.5px", color: light.muted }}>
                {row.sub}
              </span>
            ) : null}
            {row.why ? (
              <span className="vd-warn-text" style={{ display: "block", fontSize: "12.5px", color: light.warnText, marginTop: "2px" }}>
                <Rich value={row.why} link="warn" />
              </span>
            ) : null}
          </td>
          {row.cells.map((cell, i) => {
            const c = typeof cell === "string" ? { value: cell } : cell;
            const align = cols[i + 1]?.align ?? "right";
            return (
              <td
                key={i}
                className={`${c.hot ? "vd-warn-text" : "vd-fg"} vd-rule`}
                align={align}
                valign="top"
                style={text(13.5, c.hot ? light.warnText : light.foreground, {
                  padding: "9px 0 9px 10px",
                  borderTop: rule,
                  textAlign: align,
                  whiteSpace: "nowrap",
                  verticalAlign: "top",
                  fontWeight: c.hot ? 600 : 400,
                })}
              >
                {c.spark ? <MiniSpark values={c.spark} /> : c.value}
                {c.sub ? (
                  <span className="vd-muted" style={{ display: "block", fontSize: "11.5px", color: light.muted, fontWeight: 400 }}>
                    {c.sub}
                  </span>
                ) : null}
              </td>
            );
          })}
        </tr>
      ))}
      {footer ? (
        <tr>
          <td colSpan={cols.length} className="vd-muted vd-rule" style={text(13.5, light.muted, { padding: "9px 0", borderTop: rule })}>
            <Rich value={footer} link="soft" />
          </td>
        </tr>
      ) : null}
    </Table>
  );
}

/** Labels longer than this stack over their value so the value keeps the full width. */
export const STACK_LABEL_CHARS = 24;

function FactValue({ fact }: { fact: MailFact }) {
  if (fact.rich) return <Rich value={fact.rich} />;
  return fact.href ? <NameLink href={fact.href}>{fact.value}</NameLink> : <>{fact.value}</>;
}

function FactLabel({ fact }: { fact: MailFact }) {
  return fact.labelHref ? <NameLink href={fact.labelHref} tone="soft">{fact.label}</NameLink> : <>{fact.label}</>;
}

/** Key/value rows. */
export function FactsTable({ facts }: { facts: MailFact[] }) {
  const rule = `1px solid ${light.border}`;
  const valueStyle = (fact: MailFact, padding: string) =>
    text(14, light.foreground, {
      padding,
      wordBreak: "break-word",
      overflowWrap: "anywhere",
      ...(fact.mono ? { fontFamily: MONO, fontSize: "13px" } : {}),
    });
  if (facts.some((f) => f.label.length > STACK_LABEL_CHARS)) {
    return (
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        {facts.map((fact, index) => (
          <tr key={index}>
            <td className="vd-rule" style={{ padding: "10px 0", borderTop: rule }}>
              {fact.label ? (
                <p className="vd-muted" style={text(13, light.muted, { wordBreak: "break-word", overflowWrap: "anywhere" })}>
                  <FactLabel fact={fact} />
                </p>
              ) : null}
              <p className="vd-fg" style={valueStyle(fact, "0")}>
                <FactValue fact={fact} />
              </p>
            </td>
          </tr>
        ))}
      </Table>
    );
  }
  return (
    <Table width="100%">
      {facts.map((fact, index) => (
        <tr key={index}>
          <td
            className="vd-muted vd-rule"
            valign="top"
            width="110"
            style={text(14, light.muted, { padding: "10px 14px 10px 0", borderTop: rule, width: "110px", verticalAlign: "top" })}
          >
            <FactLabel fact={fact} />
          </td>
          <td className="vd-fg vd-rule" valign="top" style={{ ...valueStyle(fact, "10px 0"), borderTop: rule, verticalAlign: "top" }}>
            <FactValue fact={fact} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function Chips({ chips }: { chips: { text: string; new?: boolean }[] }) {
  return (
    <p style={{ margin: "0 0 -6px", lineHeight: "26px" }}>
      {chips.map((c, i) => (
        <Chip key={i} isNew={c.new}>
          {c.text}
        </Chip>
      ))}
    </p>
  );
}

/** Three steps: done, current, upcoming. */
export function Timeline({ steps, current }: { steps: TimelineStep[]; current: number }) {
  const dot = (i: number) => {
    const state = i < current ? "done" : i === current ? "now" : "next";
    const border = state === "next" ? RAMP_LIGHT[2] : RAMP_LIGHT[4];
    const bg = state === "done" ? RAMP_LIGHT[4] : light.background;
    return (
      <td width="12" style={{ ...CELL_RESET, width: "12px" }}>
        <Table>
          <tr>
            <td
              className={`vd-dot-${state}`}
              width="8"
              height="8"
              bgcolor={bg}
              style={{
                ...CELL_RESET,
                width: "8px",
                height: "8px",
                background: bg,
                border: `2px solid ${border}`,
                borderRadius: "6px",
                boxShadow: state === "now" ? `0 0 0 3px ${RAMP_LIGHT[1]}` : undefined,
              }}
            >
              {NBSP}
            </td>
          </tr>
        </Table>
      </td>
    );
  };
  const line = (done: boolean) => {
    const fill = rampFill(done ? 4 : 1);
    return (
      <td valign="middle" style={{ ...CELL_RESET, padding: "0 4px", verticalAlign: "middle" }}>
        <Table width="100%">
          <tr>
            <td className={fill.className} height="2" bgcolor={fill.color} style={{ ...CELL_RESET, height: "2px", background: fill.color }}>
              {NBSP}
            </td>
          </tr>
        </Table>
      </td>
    );
  };
  const last = steps.length - 1;
  return (
    <>
      <Table width="100%">
        <tr>
          {steps.flatMap((_, i) => (i === 0 ? [<Fragment key={i}>{dot(i)}</Fragment>] : [<Fragment key={`l${i}`}>{line(i <= current)}</Fragment>, <Fragment key={i}>{dot(i)}</Fragment>]))}
        </tr>
      </Table>
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {steps.map((step, i) => {
            const align = i === 0 ? "left" : i === last ? "right" : "center";
            return (
              <td key={i} align={align} valign="top" className="vd-muted" style={text(12, light.muted, { padding: "6px 0 0", textAlign: align, verticalAlign: "top", lineHeight: 1.4 })}>
                <span className="vd-fg" style={{ display: "block", color: light.foreground, fontWeight: 600, fontSize: "12.5px" }}>
                  {step.label}
                </span>
                {step.date}
              </td>
            );
          })}
        </tr>
      </Table>
    </>
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

const ERROR_LINE = /\b(error|fatal|panic|exception|failed|denied|refused)\b/i;

/** The last line that reads like the error, or none. */
export function errorLines(lines: string[]): number[] {
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i])) return [i];
  return [];
}

/** Mono log or command, with the error line in red. `highlight` indexes the capped lines. */
export function LogBlock({ title, lines, highlight }: { title?: string; lines: string[]; highlight?: number[] }) {
  const capped = capLogLines(lines);
  if (capped.length === 0) return null;
  const marked = new Set(highlight ?? errorLines(capped));
  return (
    <>
      {title ? (
        <div style={{ margin: "0 0 10px" }}>
          <SectionTitle>{title}</SectionTitle>
        </div>
      ) : null}
      <pre
        className="vd-code"
        style={{
          margin: 0,
          padding: "12px 14px",
          background: light.code,
          color: light.codeText,
          borderRadius: "8px",
          fontFamily: MONO,
          fontSize: "12px",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {capped.map((line, i) => (
          <span key={i}>
            {marked.has(i) ? (
              <span className="vd-fail-text" style={{ color: light.fail, fontWeight: 600 }}>
                {line}
              </span>
            ) : (
              line
            )}
            {i < capped.length - 1 ? "\n" : null}
          </span>
        ))}
      </pre>
    </>
  );
}

/** A command, no highlight. */
export function CodeBlock({ title, lines }: { title?: string; lines: string[] }) {
  return <LogBlock title={title} lines={lines} highlight={[]} />;
}

export function PrimaryButton({ href, children }: { href: string; children: string }) {
  return (
    <Table>
      <tr>
        <td className="vd-btn" bgcolor={light.primary} style={{ borderRadius: "8px", background: light.primary }}>
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

/** "Sent by Vardo on node-a (vardo.example.com)". */
export function footerLine(footer: MailFooter): string {
  const host = footer.consoleHost && footer.consoleHost !== footer.instanceName ? ` (${footer.consoleHost})` : "";
  return `Sent by Vardo on ${footer.instanceName}${host}`;
}

/** Note, then links: "Version 1.4.0 · Deployment log · Notification settings". */
export function MailFooterBlock({ footer, links = [] }: { footer: MailFooter; links?: MailLink[] }) {
  const all = [...links, { label: footer.settingsLabel ?? "Notification settings", href: footer.settingsUrl }];
  return (
    <p className="vd-muted" style={text(12, light.muted, { lineHeight: 1.6 })}>
      {footer.note ?? null}
      {all.map((link, i) => (
        <span key={i}>
          {i > 0 || footer.note ? " · " : null}
          <Link className="vd-muted" href={link.href} style={{ color: light.muted, textDecoration: "underline" }}>
            {link.label}
          </Link>
        </span>
      ))}
    </p>
  );
}

// Charts: table cells only, so Gmail, Apple Mail and Outlook draw them the same.

function ChartTitle({ title }: { title?: string }) {
  if (!title) return null;
  return (
    <div style={{ margin: "0 0 10px" }}>
      <SectionTitle>{title}</SectionTitle>
    </div>
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

function Swatch({ fill }: { fill: Fill }) {
  return (
    <span className={fill.className} style={{ display: "inline-block", width: "9px", height: "9px", background: fill.color, borderRadius: "2px", marginRight: "4px" }}>
      {NBSP}
    </span>
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
export function StackedBar({ title, segments, caption }: { title?: string; segments: ChartSegment[]; caption?: string }) {
  const shown = segments.filter((s) => s.value > 0);
  const pct = percentages(shown.map((s) => s.value));
  if (shown.length === 0) return null;
  return (
    <>
      <ChartTitle title={title} />
      <Table width="100%" style={{ tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }}>
        <tr>
          {shown.map((s, i) => {
            const fill = chartFill(s.tone ?? ((i % 4) as ChartTone));
            return (
              <td
                key={i}
                className={`${fill.className} vd-gap`}
                width={`${pct[i]}%`}
                height="10"
                bgcolor={fill.color}
                style={{ ...CELL_RESET, width: `${pct[i]}%`, height: "10px", background: fill.color, borderRight: i < shown.length - 1 ? `2px solid ${light.background}` : undefined }}
              >
                {NBSP}
              </td>
            );
          })}
        </tr>
      </Table>
      <Table width="100%" style={{ margin: "8px 0 0" }}>
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
    </>
  );
}

/** Width phase labels are fitted against; smaller than the layout so phones keep them. */
export const PHASE_LABEL_WIDTH = 420;

/** Whether a segment `pct` wide has room for its label and detail. */
export function phaseLabelFits(pct: number, label: string, detail = "", width = PHASE_LABEL_WIDTH): boolean {
  if (pct < 8) return false;
  const needed = Math.max(textWidth(label.length, 12, 0.6), textWidth(detail.length, 11.5, 0.55)) + 4;
  return needed <= (pct / 100) * width;
}

/** Where the time went: segments with labels under the wide ones, the failed one red. */
export function PhaseBar({ title, steps, caption }: { title?: string; steps: PhaseStep[]; caption?: string }) {
  const shown = steps.filter((s) => s.value > 0 || s.failed);
  if (shown.length === 0) return null;
  const pct = percentages(shown.map((s) => Math.max(s.value, s.failed ? 1 : 0)));
  const tones: RampStep[] = [4, 3, 2, 1];
  return (
    <>
      <ChartTitle title={title} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {shown.map((s, i) => {
            const fill: Fill = s.failed ? { color: light.fail, className: "vd-fill-fail" } : rampFill(tones[i % 4]);
            return (
              <td
                key={i}
                className={`${fill.className} vd-gap`}
                width={`${pct[i]}%`}
                height="12"
                bgcolor={fill.color}
                style={{ ...CELL_RESET, width: `${pct[i]}%`, height: "12px", background: fill.color, borderRight: i < shown.length - 1 ? `2px solid ${light.background}` : undefined }}
              >
                {NBSP}
              </td>
            );
          })}
        </tr>
      </Table>
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {shown.map((s, i) => (
            <td key={i} width={`${pct[i]}%`} valign="top" className="vd-muted" style={text(11.5, light.muted, { width: `${pct[i]}%`, padding: "5px 0 0", verticalAlign: "top", overflow: "hidden", whiteSpace: "nowrap", lineHeight: 1.4 })}>
              {phaseLabelFits(pct[i], s.label, s.detail) ? (
                <>
                  <span className={s.failed ? "vd-fail-text" : "vd-fg"} style={{ display: "block", fontSize: "12px", fontWeight: 600, color: s.failed ? light.fail : light.foreground }}>
                    {s.label}
                  </span>
                  {s.detail ?? `${pct[i]}%`}
                </>
              ) : (
                NBSP
              )}
            </td>
          ))}
        </tr>
      </Table>
      <ChartCaption caption={caption} />
    </>
  );
}

/** Neutral under the warning line, amber past it, red past critical. */
export function gaugeFill(percent: number, warn: number, critical: number): "ok" | "warn" | "fail" {
  return percent >= critical ? "fail" : percent >= warn ? "warn" : "ok";
}

/** A bar filled to `percent` in its threshold's color, with a label row. */
export function GaugeBar({ title, percent, warn, critical, label, caption }: Extract<MailVisual, { kind: "gauge" }>) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  const state = gaugeFill(percent, warn, critical);
  const fill: Fill = state === "ok" ? rampFill(3) : chartFill(state);
  const track = rampFill(1);
  return (
    <>
      <ChartTitle title={title ? `${title} · ${value}%` : undefined} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {value > 0 ? (
            <td className={fill.className} width={`${value}%`} height="12" bgcolor={fill.color} style={{ ...CELL_RESET, width: `${value}%`, height: "12px", background: fill.color }}>
              {NBSP}
            </td>
          ) : null}
          {value < 100 ? (
            <td className={track.className} height="12" bgcolor={track.color} style={{ ...CELL_RESET, height: "12px", background: track.color }}>
              {NBSP}
            </td>
          ) : null}
        </tr>
      </Table>
      <Table width="100%">
        <tr>
          <td className="vd-muted" style={text(11.5, light.muted, { padding: "5px 8px 0 0" })}>
            {label ?? `${value}%`}
          </td>
          <td className="vd-muted" align="right" style={text(11.5, light.muted, { padding: "5px 0 0", textAlign: "right" })}>
            {`alerts at ${warn}%, critical at ${critical}%`}
          </td>
        </tr>
      </Table>
      <ChartCaption caption={caption} />
    </>
  );
}

const COLUMN_HEIGHT = 60;
const COMPACT_HEIGHT = 32;

/** The value bars start from: zero, or just under the lowest when every value sits high. */
export function columnBase(values: number[], baseline: "zero" | "auto" = "zero"): number {
  if (baseline === "zero" || values.length === 0) return 0;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return min > max * 0.6 ? min * 0.9 : 0;
}

/** Bar heights in px; anything above zero gets at least 3. */
export function columnHeights(values: number[], height: number, baseline: "zero" | "auto" = "zero"): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0) return values.map(() => 0);
  const base = columnBase(values, baseline);
  return values.map((v) => (v <= 0 ? 0 : Math.max(3, Math.round(((v - base) / (max - base)) * height))));
}

/** Columns of stacked parts. Untoned parts are dark neutral; "fail" and "warn" mark columns red and amber. */
export function ColumnChart({ title, columns, axis, legend, caption, compact, baseline }: Extract<MailVisual, { kind: "columns" }>) {
  if (columns.length === 0) return null;
  const chartHeight = compact ? COMPACT_HEIGHT : COLUMN_HEIGHT;
  const totals = columns.map((c) => c.parts.reduce((sum, p) => sum + Math.max(0, p.value), 0));
  const heights = columnHeights(totals, chartHeight, baseline);
  const bars: Bar[] = columns.map((column, i) => {
    const total = totals[i];
    let left = heights[i];
    return {
      parts: column.parts.map((part, j) => {
        const share = total > 0 ? Math.max(0, part.value) / total : 0;
        const isLast = j === column.parts.length - 1;
        const h = part.value > 0 ? (isLast ? left : Math.min(left, Math.max(2, Math.round(share * heights[i])))) : 0;
        left -= h;
        return { h, fill: part.tone === undefined ? rampFill(3) : chartFill(part.tone) };
      }),
    };
  });
  return (
    <>
      <ChartTitle title={title} />
      <Bars bars={bars} height={chartHeight} pad={compact ? "0 3px" : "0 1px"} />
      {columns.some((c) => c.label) ? (
        <Table width="100%" style={{ tableLayout: "fixed" }}>
          <tr>
            {columns.map((c, i) => (
              <td key={i} className="vd-muted" align="center" style={text(11, light.muted, { padding: "4px 0 0", textAlign: "center" })}>
                {c.label ?? NBSP}
              </td>
            ))}
          </tr>
        </Table>
      ) : null}
      {axis ? (
        <Table width="100%">
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
          {legend.map((item, i) => (
            <span key={i}>
              {i > 0 ? "   " : null}
              <Swatch fill={chartFill(item.tone)} />
              {item.label}
            </span>
          ))}
        </p>
      ) : null}
      <ChartCaption caption={caption} />
    </>
  );
}

const DAY_FILL: Record<DayState, Fill> = {
  ok: { color: light.success, className: "vd-fill-success" },
  fail: { color: light.fail, className: "vd-fill-fail" },
  none: { color: RAMP_LIGHT[1], className: "vd-r1" },
};

/** One square per run or day, green or red. */
export function DayGrid({ title, days, legend = ["succeeded", "failed"], summary }: Extract<MailVisual, { kind: "days" }>) {
  if (days.length === 0) return null;
  return (
    <>
      <ChartTitle title={title} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {days.map((d, i) => (
            <td
              key={i}
              className={`${DAY_FILL[d].className} vd-gap`}
              height="14"
              bgcolor={DAY_FILL[d].color}
              style={{ ...CELL_RESET, height: "14px", background: DAY_FILL[d].color, borderRight: i < days.length - 1 ? `3px solid ${light.background}` : undefined }}
            >
              {NBSP}
            </td>
          ))}
        </tr>
      </Table>
      <p className="vd-muted" style={text(12, light.muted, { margin: "6px 0 0" })}>
        <Swatch fill={DAY_FILL.ok} />
        {`${legend[0]}   `}
        <Swatch fill={DAY_FILL.fail} />
        {legend[1]}
        {summary ? `   ${summary}` : null}
      </p>
    </>
  );
}

/** 0 to 4 per hour against the busiest; any activity is at least 1. */
export function hourLevels(values: number[]): RampStep[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max <= 0 || v <= 0 ? 0 : (Math.max(1, Math.min(4, Math.round((v / max) * 4))) as RampStep)));
}

/** "12 am", "9 am", "noon", "6 pm". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12 am";
  if (h === 12) return "noon";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

const HOUR_AXIS: { label: string; width: string; align: "left" | "center" | "right" }[] = [
  { label: hourLabel(0), width: "12.5%", align: "left" },
  { label: hourLabel(6), width: "25%", align: "center" },
  { label: hourLabel(12), width: "25%", align: "center" },
  { label: hourLabel(18), width: "25%", align: "center" },
  { label: hourLabel(23), width: "12.5%", align: "right" },
];

/** A day's 24 hours on a neutral ramp. */
export function HourStrip({ title, values }: Extract<MailVisual, { kind: "hours" }>) {
  if (values.length === 0) return null;
  const levels = hourLevels(values);
  return (
    <>
      <ChartTitle title={title} />
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {levels.map((level, i) => {
            const fill = rampFill(level);
            return (
              <td
                key={i}
                className={`${fill.className} vd-gap`}
                height="22"
                bgcolor={fill.color}
                style={{ ...CELL_RESET, height: "22px", background: fill.color, borderRight: i < levels.length - 1 ? `2px solid ${light.background}` : undefined }}
              >
                {NBSP}
              </td>
            );
          })}
        </tr>
      </Table>
      <Table width="100%" style={{ tableLayout: "fixed" }}>
        <tr>
          {HOUR_AXIS.map((a, i) => (
            <td key={i} width={a.width} align={a.align} className="vd-muted" style={text(11, light.muted, { width: a.width, textAlign: a.align, padding: "4px 0 0" })}>
              {a.label}
            </td>
          ))}
        </tr>
      </Table>
    </>
  );
}

/** One bar per volume, sized against the others, with its size and change. */
export function VolumeBars({ title, rows, caption }: Extract<MailVisual, { kind: "volumes" }>) {
  if (rows.length === 0) return null;
  const pct = percentages(rows.map((r) => Math.max(r.value, 0.0001)));
  const rule = `1px solid ${light.border}`;
  const track = rampFill(1);
  return (
    <>
      <ChartTitle title={title} />
      <Table width="100%" style={{ fontVariantNumeric: "tabular-nums" }}>
        {rows.map((row, i) => {
          const fill: Fill = row.flag ? chartFill("warn") : rampFill(3);
          const p = Math.max(1, pct[i]);
          return (
            <tr key={i}>
              <td className="vd-fg vd-rule" width="34%" style={text(12.5, light.foreground, { fontFamily: MONO, width: "34%", padding: "7px 10px 7px 0", borderTop: rule, verticalAlign: "middle", wordBreak: "break-word", overflowWrap: "anywhere" })}>
                {row.name}
              </td>
              <td className="vd-rule" width="44%" style={{ padding: "7px 0", borderTop: rule, width: "44%", verticalAlign: "middle" }}>
                <Table width="100%" style={{ tableLayout: "fixed" }}>
                  <tr>
                    <td className={fill.className} width={`${p}%`} height="8" bgcolor={fill.color} style={{ ...CELL_RESET, width: `${p}%`, height: "8px", background: fill.color }}>
                      {NBSP}
                    </td>
                    {p < 100 ? (
                      <td className={track.className} height="8" bgcolor={track.color} style={{ ...CELL_RESET, height: "8px", background: track.color }}>
                        {NBSP}
                      </td>
                    ) : null}
                  </tr>
                </Table>
              </td>
              <td className="vd-fg vd-rule" align="right" style={text(13.5, light.foreground, { padding: "7px 0 7px 10px", borderTop: rule, textAlign: "right", whiteSpace: "nowrap", verticalAlign: "middle", lineHeight: 1.35 })}>
                {row.size}
                {row.flag || row.change ? (
                  <span className={row.flag ? "vd-warn-text" : "vd-muted"} style={{ display: "block", fontSize: "11.5px", color: row.flag ? light.warnText : light.muted }}>
                    {[row.flag, row.change].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </td>
            </tr>
          );
        })}
        {caption ? (
          <tr>
            <td colSpan={3} className="vd-muted" style={text(11.5, light.muted, { padding: "4px 0 0" })}>
              {caption}
            </td>
          </tr>
        ) : null}
      </Table>
    </>
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
    case "phases":
      return <PhaseBar {...visual} />;
    case "days":
      return <DayGrid {...visual} />;
    case "hours":
      return <HourStrip {...visual} />;
    case "volumes":
      return <VolumeBars {...visual} />;
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
  const head = (s: string) => (visual.title ? `${visual.title}${s}` : "");
  switch (visual.kind) {
    case "stacked": {
      const shown = visual.segments.filter((s) => s.value > 0);
      const pct = percentages(shown.map((s) => s.value));
      const line = shown.map((s, i) => `${s.label} ${pct[i]}%${s.tone === "fail" ? " ✗" : ""}`).join(" · ");
      return [visual.title, line, visual.caption].filter(Boolean).join("\n");
    }
    case "gauge": {
      const value = Math.round(Math.max(0, Math.min(100, visual.percent)));
      const filled = Math.round(value / 5);
      const bar = `[${"#".repeat(filled)}${"-".repeat(20 - filled)}]`;
      const lead = visual.title ? `${visual.title}: ${value}%` : `${value}%`;
      const label = visual.label ? ` ${visual.label}` : "";
      return [`${lead}${label} ${bar} (alerts at ${visual.warn}%, critical at ${visual.critical}%)`, visual.caption].filter(Boolean).join("\n");
    }
    case "columns": {
      const totals = visual.columns.map((c) => c.parts.reduce((sum, p) => sum + Math.max(0, p.value), 0));
      const axis = visual.axis ? ` (${visual.axis[0]} → ${visual.axis[1]})` : "";
      return [head(axis), sparkline(totals), visual.caption].filter(Boolean).join("\n");
    }
    case "phases": {
      const shown = visual.steps.filter((s) => s.value > 0 || s.failed);
      const pct = percentages(shown.map((s) => Math.max(s.value, s.failed ? 1 : 0)));
      const line = shown.map((s, i) => `${s.label} ${s.detail ?? `${pct[i]}%`}${s.failed ? " ✗" : ""}`).join(" · ");
      return [visual.title, line, visual.caption].filter(Boolean).join("\n");
    }
    case "days": {
      const [ok, fail] = visual.legend ?? ["succeeded", "failed"];
      const failed = visual.days.filter((d) => d === "fail").length;
      const passed = visual.days.filter((d) => d === "ok").length;
      const glyphs = visual.days.map((d) => (d === "ok" ? "✓" : d === "fail" ? "✗" : "·")).join("");
      const counts = [`${passed} ${ok}`, failed ? `${failed} ${fail}` : ""].filter(Boolean).join(", ");
      return [visual.title, `${glyphs} ${counts}`, visual.summary].filter(Boolean).join("\n");
    }
    case "hours": {
      const peak = visual.values.indexOf(Math.max(...visual.values));
      const busiest = Math.max(...visual.values) > 0 ? ` busiest around ${hourLabel(peak)}` : "";
      return [visual.title, `${sparkline(visual.values)} (${hourLabel(0)} → ${hourLabel(23)})${busiest}`].filter(Boolean).join("\n");
    }
    case "volumes": {
      const lines = visual.rows.map((r) => `${r.name}: ${r.size}${r.change ? `, ${r.change}` : ""}${r.flag ? ` (${r.flag})` : ""}`);
      return [visual.title, ...lines, visual.caption].filter(Boolean).join("\n");
    }
  }
}

function factsText(facts: MailFact[]): string {
  return facts
    .map((f) => {
      const href = f.href ?? f.labelHref;
      const link = href && href !== f.value && href !== `https://${f.value}` ? ` <${href}>` : "";
      return `${f.label ? `${f.label}: ` : "  "}${f.value}${link}`;
    })
    .join("\n");
}

function statsCellText(cell: StatsCell): string {
  if (typeof cell === "string") return cell;
  const value = cell.spark ? sparkline(cell.spark) : cell.value;
  return cell.sub ? `${value} (${cell.sub})` : value;
}

/** The plain-text equivalent of a block. */
export function blockText(block: MailBlock): string {
  switch (block.kind) {
    case "text":
    case "note":
    case "section":
      return richText(block.kind === "section" ? block.title : block.text);
    case "reassure":
      return block.text ? `${block.strong} ${richText(block.text)}` : block.strong;
    case "callout": {
      const mark = block.tone === "bad" ? "✗" : "⚠";
      return [
        `${mark} ${richText(block.title)}`,
        block.body ? richText(block.body) : "",
        block.visual ? visualText(block.visual) : "",
        block.action ? `${block.action.label}: ${block.action.href}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "tiles":
      return block.tiles.map((t) => `${t.label}: ${t.value}${t.unit ?? ""}${t.sub ? ` (${t.sub})` : ""}`).join("\n");
    case "stats": {
      const cols = block.columns.map((c) => (typeof c === "string" ? c : c.label));
      const rows = block.rows.map((row) => {
        const cells = row.cells.map((cell, i) => `${cols[i + 1] ?? ""} ${statsCellText(cell)}`.trim()).join(" · ");
        const name = row.sub ? `${row.name} (${row.sub})` : row.name;
        return [`${name}: ${cells}`, row.why ? `  ${richText(row.why)}` : ""].filter(Boolean).join("\n");
      });
      return [...rows, block.footer ? richText(block.footer) : ""].filter(Boolean).join("\n");
    }
    case "facts":
      return factsText(block.facts);
    case "chips":
      return block.chips.map((c) => chipText(c.text, c.new)).join(", ");
    case "timeline":
      return block.steps
        .map((s, i) => `${i < block.current ? "✓" : i === block.current ? "●" : "○"} ${s.label} ${s.date}`)
        .join(" → ");
    case "log": {
      const lines = capLogLines(block.lines);
      if (lines.length === 0) return "";
      const marked = new Set(block.highlight ?? errorLines(lines));
      const body = lines.map((l, i) => `${marked.has(i) ? "  > " : "    "}${l}`).join("\n");
      return block.title ? `${block.title}\n${body}` : body;
    }
    default:
      return visualText(block);
  }
}

/** Space above a block, from the one before it. */
export function blockGap(prev: MailBlock["kind"] | undefined, kind: MailBlock["kind"]): number {
  if (!prev) return kind === "section" ? 12 : 0;
  if (kind === "section") return 26;
  if (prev === "section") return 10;
  if (prev === "callout" && kind === "callout") return 10;
  if (kind === "note") return 8;
  if (prev === "text" && kind === "text") return 14;
  return 20;
}

export function Block({ block }: { block: MailBlock }) {
  switch (block.kind) {
    case "text":
      return <Lead text={block.text} />;
    case "reassure":
      return <Reassurance strong={block.strong} text={block.text} />;
    case "callout":
      return <Callout {...block} />;
    case "section":
      return (
        <SectionTitle>
          <Rich value={block.title} link="soft" />
        </SectionTitle>
      );
    case "note":
      return <Note text={block.text} />;
    case "tiles":
      return <StatTiles tiles={block.tiles} />;
    case "stats":
      return <StatsTable {...block} />;
    case "facts":
      return <FactsTable facts={block.facts} />;
    case "chips":
      return <Chips chips={block.chips} />;
    case "timeline":
      return <Timeline steps={block.steps} current={block.current} />;
    case "log":
      return <LogBlock title={block.title} lines={block.lines} highlight={block.highlight} />;
    default:
      return <Visual visual={block} />;
  }
}

/** Blocks in order, each in its own row so spacing holds in Outlook. */
export function Blocks({ blocks }: { blocks: MailBlock[] }) {
  return (
    <Table width="100%">
      {blocks.map((block, i) => (
        <tr key={i}>
          <td style={{ paddingTop: `${blockGap(blocks[i - 1]?.kind, block.kind)}px` }}>
            <Block block={block} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Every block above the button, the older fields mapped onto the kit. Details go under it. */
export function bodyBlocks(body: NotificationMailBody): MailBlock[] {
  const blocks: MailBlock[] = [];
  for (const p of body.paragraphs ?? []) blocks.push({ kind: "text", text: p });
  blocks.push(...(body.blocks ?? []));
  blocks.push(...(body.visuals ?? []));
  if (body.facts?.length) blocks.push({ kind: "facts", facts: body.facts });
  for (const section of body.sections ?? []) {
    if (section.facts.length) blocks.push({ kind: "section", title: section.title }, { kind: "facts", facts: section.facts });
  }
  if (body.log && capLogLines(body.log.lines).length) blocks.push({ kind: "log", title: body.log.title, lines: body.log.lines });
  if (body.command) blocks.push({ kind: "log", title: body.command.title, lines: [body.command.text], highlight: [] });
  return blocks;
}

/** Preheaders past this are cut at a word. */
export const PREHEADER_MAX = 90;

/** One line for the inbox preview, at most PREHEADER_MAX characters, cut at a word. */
export function capPreheader(value: string, max = PREHEADER_MAX): string {
  return truncate(value, max);
}

function firstText(blocks: MailBlock[]): string | undefined {
  for (const b of blocks) {
    if (b.kind === "text") return richText(b.text);
    if (b.kind === "reassure") return blockText(b);
  }
  return undefined;
}

/** Flat page: brand line over a rule, content, footer under a rule. */
function Shell({ title, preheader, brand, footer, children }: { title: string; preheader: string; brand: ReactNode; footer: ReactNode; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </Head>
      <Body className="vd-bg" style={{ margin: 0, padding: 0, background: light.background }}>
        <Preview useTitleTag={false}>{preheader}</Preview>
        <Table width="100%" className="vd-bg" style={{ background: light.background }}>
          <tr>
            <td align="center" className="vd-outer vd-bg" bgcolor={light.background} style={{ padding: "28px 24px" }}>
              <Table width="100%" style={{ maxWidth: "560px" }}>
                <tr>
                  <td className="vd-rule" style={{ padding: "0 0 18px", borderBottom: `1px solid ${light.border}` }}>
                    {brand}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "22px 0 28px" }}>{children}</td>
                </tr>
                <tr>
                  <td className="vd-rule" style={{ padding: "18px 0 0", borderTop: `1px solid ${light.border}` }}>
                    {footer}
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

/** The layout every notification email renders through. */
export function NotificationMail(body: NotificationMailBody) {
  const blocks = bodyBlocks(body);
  const preheader = capPreheader(body.preheader ?? firstText(blocks) ?? body.heading);
  return (
    <Shell
      title={body.heading}
      preheader={preheader}
      brand={<MailHeader instanceName={body.footer.instanceName} href={body.footer.consoleUrl} />}
      footer={<MailFooterBlock footer={body.footer} links={body.links} />}
    >
      <div style={{ padding: "0 0 8px" }}>
        <Title>{body.heading}</Title>
      </div>
      <Blocks blocks={blocks} />
      {body.action ? (
        <div style={{ paddingTop: blocks.length ? "24px" : "12px" }}>
          <PrimaryButton href={body.action.href}>{body.action.label}</PrimaryButton>
        </div>
      ) : null}
      {body.details?.length ? (
        <div style={{ paddingTop: "28px" }}>
          <Blocks blocks={[{ kind: "section", title: "Technical details" }, { kind: "facts", facts: body.details }]} />
        </div>
      ) : null}
    </Shell>
  );
}

/** The plain-text part, from the same body the HTML renders. */
export function notificationMailText(body: NotificationMailBody): string {
  const out: string[] = [body.heading];
  let pendingSection: string | null = null;
  for (const block of bodyBlocks(body)) {
    const value = blockText(block);
    if (block.kind === "section") {
      pendingSection = value;
      continue;
    }
    if (!value) continue;
    out.push(pendingSection ? `${pendingSection}\n${value}` : value);
    pendingSection = null;
  }
  const links = [...(body.action ? [body.action] : []), ...(body.links ?? [])];
  if (links.length) out.push(links.map((l) => `${l.label}: ${l.href}`).join("\n"));
  if (body.details?.length) out.push(`Technical details\n${factsText(body.details)}`);
  const footer = body.footer;
  const settings = `${footer.settingsLabel ?? "Notification settings"}: ${footer.settingsUrl}`;
  out.push(["--", footer.note, settings, `${footerLine(footer)}.`].filter(Boolean).join("\n"));
  return out.join("\n\n") + "\n";
}

// Account emails (invite, magic link). Light only: their copy sets its own colors.

export function EmailLayout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: "body{margin:0;padding:0}@media (max-width:520px){.vd-outer{padding:20px 16px !important}}" }} />
      </Head>
      <Body style={{ margin: 0, padding: 0, background: light.background, fontFamily: FONT }}>
        <Preview>{preview}</Preview>
        <Table width="100%" style={{ background: light.background }}>
          <tr>
            <td align="center" className="vd-outer" style={{ padding: "28px 24px" }}>
              <Table width="100%" style={{ maxWidth: "480px" }}>
                <tr>
                  <td style={{ padding: "0 0 18px", borderBottom: `1px solid ${light.border}` }}>
                    <p style={text(15, light.foreground, { fontWeight: 600 })}>Vardo</p>
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "22px 0 28px", textAlign: "left" }}>{children}</td>
                </tr>
                <tr>
                  <td style={{ padding: "18px 0 0", borderTop: `1px solid ${light.border}` }}>
                    <p style={text(12, light.muted)}>Sent by Vardo</p>
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

export function CTA({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: light.primary,
        color: light.onPrimary,
        padding: "11px 20px",
        borderRadius: "8px",
        fontWeight: "600",
        fontSize: "14px",
        lineHeight: "18px",
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      {children}
    </Button>
  );
}

export const styles = {
  h1: { color: light.foreground, fontSize: "22px", fontWeight: "700", margin: "0 0 8px", lineHeight: "1.25" } as CSSProperties,
  text: { color: light.soft, fontSize: "15px", lineHeight: "1.55", margin: "0 0 16px" } as CSSProperties,
  muted: { color: light.muted, fontSize: "13px", lineHeight: "1.55", margin: "0 0 16px" } as CSSProperties,
};
