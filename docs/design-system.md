# Vardo Design System

Reference documentation extracted from the codebase. Describes what exists today -- not aspirational.

---

## Color System

All colors use the **oklch** color space. Theme tokens are defined as CSS custom properties in `app/globals.css` and consumed through Tailwind's `@theme inline` mapping.

### Core Tokens (Light / Dark)

| Token | Light | Dark |
|---|---|---|
| `--background` | `oklch(0.975 0.005 260)` | `oklch(0.1 0.005 260)` |
| `--foreground` | `oklch(0.12 0.005 260)` | `oklch(0.92 0.005 260)` |
| `--card` | `oklch(0.995 0.003 260)` | `oklch(0.14 0.005 260)` |
| `--primary` | `oklch(0.16 0.005 260)` | `oklch(0.95 0.003 260)` |
| `--secondary` | `oklch(0.94 0.006 260)` | `oklch(0.2 0.005 260)` |
| `--muted` | `oklch(0.95 0.005 260)` | `oklch(0.2 0.005 260)` |
| `--muted-foreground` | `oklch(0.45 0.01 260)` | `oklch(0.55 0.008 260)` |
| `--accent` | `oklch(0.92 0.006 260)` | `oklch(0.22 0.006 260)` |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |
| `--border` | `oklch(0.89 0.006 260)` | `oklch(1 0.005 260 / 12%)` |
| `--input` | `oklch(0.89 0.006 260)` | `oklch(1 0.005 260 / 15%)` |
| `--ring` | `oklch(0.16 0.005 260)` | `oklch(0.95 0.003 260)` |

The hue channel is consistently **260** (blue-gray) across all neutral tokens. Chroma is kept very low (0.003--0.01) for neutrals.

Dark mode border and input tokens use **alpha transparency** (`/ 12%`, `/ 15%`) rather than solid colors, letting them blend on any surface.

### Sidebar Tokens

Separate token set for the sidebar surface (`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`). Light sidebar is `oklch(0.96 ...)`, dark is `oklch(0.07 ...)`.

### Status Colors

Five semantic status colors, each with a full-opacity and a `muted` (10--12% alpha) variant:

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--status-success` | `oklch(0.45 0.14 155)` | `oklch(0.7 0.12 155)` | Running, active, success |
| `--status-error` | `oklch(0.5 0.18 25)` | `oklch(0.7 0.14 25)` | Error, failed |
| `--status-warning` | `oklch(0.55 0.16 70)` | `oklch(0.75 0.12 70)` | Needs restart, at risk |
| `--status-info` | `oklch(0.45 0.14 240)` | `oklch(0.7 0.12 240)` | Deploying, staging |
| `--status-neutral` | `oklch(0.45 0.01 260)` | `oklch(0.45 0.005 260)` | Stopped, inactive |

Muted variants (e.g. `--status-success-muted`) are the same color at 10% (light) or 12% (dark) opacity. Used for badge backgrounds: `bg-status-success-muted text-status-success`.

Status color mapping is centralized in `lib/ui/status-colors.ts`:

```ts
statusDotColor(status)   // "active" -> "bg-status-success", "error" -> "bg-status-error", etc.
envTypeDotColor(type)    // "production" -> "bg-status-success", "staging" -> "bg-status-warning"
```

### Metric Chart Colors

Dedicated tokens for infrastructure charts, same values in light and dark:

| Token | Value | Usage |
|---|---|---|
| `--metric-cpu` | `oklch(0.65 0.19 255)` | CPU percentage charts |
| `--metric-memory` | `oklch(0.72 0.17 150)` | Memory usage charts |
| `--metric-network-rx` | `oklch(0.70 0.15 200)` | Network receive |
| `--metric-network-tx` | `oklch(0.75 0.15 75)` | Network transmit |
| `--metric-memory-limit` | `oklch(0.65 0.22 25)` | Memory limit line |
| `--metric-disk` | `oklch(0.65 0.1 30)` | Disk usage |

These are re-exported in `lib/metrics/constants.ts` as `CHART_COLORS` (raw oklch strings for SVG/canvas use) and in `components/metrics-chart.tsx` as `TREMOR_METRIC_COLORS` (`var(--metric-*)` strings for Tremor components).

### Chart Tokens

Five generic `--chart-1` through `--chart-5` tokens exist for general-purpose charts (not metric-specific).

### Project Palette

`lib/ui/colors.ts` exports a `PALETTE` array of 12 named hex colors (Slate, Red, Orange, Amber, Green, Teal, Blue, Indigo, Purple, Pink, Rose, Cyan) used for project color assignment. `randomPaletteColor()` picks one at random.

### Motion Tokens

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--duration-fast: 150ms;
--duration-normal: 250ms;
--duration-slow: 400ms;
```

Interactive elements (buttons, links, `[role="button"]`) get automatic transitions on hover using `--duration-fast` and `--ease-out-quart`. Only on devices with fine pointer (`@media (hover: hover) and (pointer: fine)`).

### Border Radius

Base `--radius` is `0.75rem`. Derived sizes:

| Token | Value |
|---|---|
| `--radius-sm` | `calc(--radius - 4px)` |
| `--radius-md` | `calc(--radius - 2px)` |
| `--radius-lg` | `--radius` (0.75rem) |
| `--radius-xl` | `calc(--radius + 4px)` |
| `--radius-2xl` | `calc(--radius + 8px)` |
| `--radius-3xl` | `calc(--radius + 12px)` |
| `--radius-4xl` | `calc(--radius + 16px)` |

---

## Typography

### Fonts

- **Sans**: Geist (`--font-geist-sans`) -- loaded via `next/font/google`, used as `font-sans`
- **Mono**: Geist Mono (`--font-geist-mono`) -- used for code, env editors, log viewers, tabular numbers

Applied on `<body>` via CSS variable classes. `antialiased` is always enabled.

### Common Patterns

| Context | Classes |
|---|---|
| Page title | `text-2xl font-semibold tracking-tight` |
| Section heading | `text-lg font-semibold` or `text-base font-semibold` |
| Card/panel title | `text-sm font-medium` |
| Body text | `text-sm text-muted-foreground` |
| Labels | `text-xs font-medium text-muted-foreground` |
| Values (detail fields) | `text-sm text-muted-foreground` |
| Metric numbers | `text-xs tabular-nums` with `text-muted-foreground` |
| Badge text | `text-xs` (via Badge component) |
| Brand | `font-semibold text-lg tracking-tight` |

Tabular numbers (`tabular-nums`) are used consistently for uptime counters, metric values, and any numeric display that updates live.

---

## Components

### shadcn/ui Base Components

All from `components/ui/`. Standard shadcn primitives:

`alert-dialog` `avatar` `badge` `button` `calendar` `card` `checkbox` `collapsible` `command` `dialog` `dropdown-menu` `form` `input` `label` `popover` `progress` `scroll-area` `select` `separator` `sheet` `switch` `table` `tabs` `textarea` `toggle` `toggle-group` `tooltip`

### Button

Variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`.

Sizes: `default` (h-10), `xs` (h-7), `sm` (h-9), `lg` (h-11), `icon` (h-10 w-10), `icon-xs` (size-7), `icon-sm` (size-9), `icon-lg` (size-11).

### Tabs

Two variants:

- **`default`** -- pill-style tabs with muted background
- **`line`** -- underline-style tabs with transparent background and a bottom indicator bar

Usage: `<TabsList variant="line">`. The line variant is used for page-level tab navigation (settings, app detail).

### Custom Components

#### IconButton (`components/ui/icon-button.tsx`)

Wraps Button + Tooltip for icon-only actions. Always includes `sr-only` text.

```tsx
<IconButton icon={X} tooltip="Close" onClick={...} />
<IconButton icon={Pencil} tooltip="Edit" loading={saving} />
```

Default variant is `ghost`, default size is `size-8`.

#### BottomSheet (`components/ui/bottom-sheet.tsx`)

Mobile-native modal that slides up from the bottom. Built on Radix Dialog. Features:

- Drag-to-dismiss with pointer capture (100px threshold)
- Three sizes: `default` (85dvh), `lg` (85dvh), `full` (95dvh)
- `squircle rounded-t-3xl` styling on the content
- Drag handle pill at top (`h-1.5 w-10 rounded-full bg-muted-foreground/30`)
- When open, sets `data-bottom-sheet-open` on `<html>` which scales main content to 97% with a `rounded-t-2xl` and shadow effect (depth illusion)

Exports: `BottomSheet`, `BottomSheetContent`, `BottomSheetHeader`, `BottomSheetTitle`, `BottomSheetDescription`, `BottomSheetFooter`, `BottomSheetClose`.

#### DetailModal (`components/ui/detail-modal.tsx`)

Full-screen bottom sheet for viewing/editing records. Two-column layout on desktop (2/3 main + 1/3 sidebar), stacked on mobile. Sticky header with title, description, action buttons, and close button.

```tsx
<DetailModal open={...} onOpenChange={...} title="..." actions={<IconButton ... />} sidebar={...}>
  {/* main content */}
</DetailModal>
```

#### ListRow / ListContainer (`components/ui/list-row.tsx`)

Unstyled list primitives for detail panels:

- `ListContainer` -- `bg-card/30 ring-1 ring-border/40`
- `ListRow` -- flex row with hover state, optional bottom border (`border-border/40`)

#### DetailField (`components/ui/detail-field.tsx`)

Label/value pair for detail views:

```tsx
<DetailField label="Created">March 2024</DetailField>
```

Label: `text-xs font-medium text-muted-foreground`. Value: `text-sm text-muted-foreground`.

#### Callout (`components/ui/callout.tsx`)

Inline alert with variant-colored border and background. Variants: `info`, `warning`, `error`, `success`. Uses Tailwind color classes (blue-500, amber-500, red-500, green-500) at low opacity for backgrounds and borders.

```tsx
<Callout variant="warning">Unsaved changes will be lost.</Callout>
```

#### ConfirmDeleteDialog (`components/ui/confirm-delete-dialog.tsx`)

Destructive confirmation dialog. Uses AlertDialog with `squircle` class. Destructive action button uses `bg-destructive text-destructive-foreground`.

#### BudgetBar (`components/ui/budget-bar.tsx`)

Progress bar for hours/fixed budget tracking. Three display modes:

- `bar` -- full progress bar with labels
- `dot` -- colored circle with tooltip
- `auto` -- container query switches between bar (>=200px) and dot (<200px)

Budget status thresholds: on_budget (<80%), at_risk (80--100%), over (100%+). Colors: `bg-primary`, `bg-amber-500`, `bg-red-500`.

#### LoadingSpinner (`components/ui/loading-spinner.tsx`)

Centered Loader2 icon with spin animation. `fullHeight` mode fills container, otherwise `py-8`.

#### DiscussionPanel (`components/ui/discussion-panel.tsx`)

Thread-style comment panel with header (icon + title + count), scrollable body, and pinned composer area.

#### EntityComments (`components/ui/entity-comments.tsx`)

Full comment system with create, edit, delete, pin/unpin. Uses DiscussionPanel for layout.

### Application-Level Components

#### StatusIndicator (`components/app-status.tsx`)

Shows app running state:

- **Running**: green pulsing dot + uptime counter (`text-status-success`)
- **Running + needsRedeploy**: warning icon + "Restart" (`text-status-warning`)
- **Error**: red text "Error" (`text-status-error`)
- **Deploying**: blue pulsing text "Deploying" (`text-status-info`)
- **Stopped**: neutral text "Stopped" (`text-status-neutral`)

#### AppIcon (`components/app-status.tsx`)

Shows detected app type icon or colored dot fallback. Three sizes: `sm` (size-8), `md` (size-10), `lg` (size-12). Container has faint brand-colored background (`{color}10` or `{color}20`).

#### DeploymentStatusBadge (`components/app-status.tsx`)

Badge with status-specific styling:

- success: `bg-status-success-muted text-status-success`
- running: `bg-status-info-muted text-status-info animate-pulse`
- failed: `bg-status-error-muted text-status-error`
- cancelled/queued: `variant="secondary"`

#### ChartCard (`components/app-status.tsx`)

Card wrapper for metric charts: `squircle rounded-lg border bg-card`, header with icon + title over a border, content area with padding.

#### PageToolbar (`components/page-toolbar.tsx`)

Horizontal bar for page-level controls. Left side: filter controls/title (flex-1). Right side: action buttons (shrink-0). Wraps responsively.

```tsx
<PageToolbar actions={<Button>New Project</Button>}>
  <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
</PageToolbar>
```

#### Sparkline (`components/app-metrics-card.tsx`)

Tiny inline SVG chart (64x20 viewbox). Draws a smooth Catmull-Rom spline through up to 20 data points. Fill uses a vertical gradient from 12% to 1% opacity of `currentColor`. Stroke is `currentColor` at 35% opacity. Used in project cards to show metric trends.

#### MetricsLine / MetricChip (`components/app-metrics-card.tsx`)

Compact inline metric display: icon + value for CPU, Memory, Disk, Network. Each metric wrapped in a tooltip. Uses `text-xs text-muted-foreground tabular-nums`. Icons from lucide: `Cpu`, `MemoryStick`, `HardDrive`, `Network`.

#### MetricsTooltip (`components/metrics-chart.tsx`)

Custom tooltip for Tremor area charts. Hard-coded dark theme (`oklch(0.14 0.005 260)` background) to ensure consistent appearance regardless of system theme.

#### CommandPalette (`components/command-palette.tsx`)

Cmd+K command palette using shadcn Command component. Shows pages and apps with search.

#### EnvEditor (`components/env-editor.tsx`)

CodeMirror-based `.env` file editor with syntax highlighting, line numbers, and clipboard integration.

#### LogViewer (`components/log-viewer.tsx`)

Real-time log viewer with syntax highlighting patterns for timestamps, log levels, HTTP methods/status codes. Status codes use `text-status-success` for 2xx, `text-status-warning` for 3xx/4xx, `text-status-error` for 5xx.

---

## Patterns

### Squircle Styling

The `squircle` class enables CSS `corner-shape: squircle` on supporting browsers (progressive enhancement via `@supports`). Squircle radii are doubled to visually match standard `border-radius` sizes.

**Where to apply**: cards, dialogs, buttons on auth pages, content panels, form inputs on auth pages. Applied via `className="squircle"` alongside a `rounded-*` class.

Common combinations:
- Cards/panels: `squircle rounded-lg border bg-card`
- Auth cards: `squircle rounded-2xl`
- Auth inputs/buttons: `squircle rounded-lg`
- Dialog content: `squircle` (on AlertDialogContent)
- Bottom sheet: `squircle rounded-t-3xl`
- Dashed add buttons: `squircle rounded-lg border border-dashed`

### Card Patterns

**Standard content card**:
```
squircle rounded-lg border bg-card p-4
```

**Card with header section**:
```
squircle rounded-lg border bg-card overflow-hidden
  > header: px-4 py-3 border-b (with icon + title)
  > content: p-4
```

**Project card** (in app-grid): Container uses a colored left accent via an absolutely-positioned `rounded-l-2xl` bar. Card body shows project icon grid, title, status, metric chips, and app chips.

**Stat cards** (metrics page): `squircle rounded-lg border bg-card px-4 py-3` with label + value.

**Dashed empty card**: `rounded-lg border border-dashed p-12` centered text + action button.

### Status Indicators

Three representation levels:

1. **Dot**: `size-2 rounded-full bg-status-*` -- used in StatusIndicator, badge swatches
2. **Badge**: `<Badge>` with `bg-status-*-muted text-status-*` -- deployment status
3. **Text**: direct `text-status-*` class -- inline status labels

Pulsing animation (`animate-pulse`) on running dots and deploying text.

### Sparklines and Chart Conventions

**Sparklines** (`Sparkline` component): SVG with Catmull-Rom interpolation, gradient fill, thin stroke. Color inherits from `currentColor`. 20-point history window.

**Area charts**: `@tremor/react` `AreaChart` component. Colors mapped through CSS variables (`var(--metric-*)`) which Tremor translates to arbitrary Tailwind values. Custom dark tooltip via `MetricsTooltip`.

**Time ranges**: `5m`, `1h`, `6h`, `24h`, `7d` defined in `lib/metrics/constants.ts` with corresponding bucket sizes.

### Form Patterns

- Standard inputs use shadcn `Input`, `Select`, `Textarea`, `Checkbox`, `Switch`
- Auth page inputs are larger: `h-11 squircle rounded-lg`
- Env editing uses CodeMirror (`EnvEditor` component)
- Editing typically happens in a BottomSheet/DetailModal rather than inline or on a separate page
- Form submission uses Server Actions or API calls with `toast.success`/`toast.error` feedback

### Toast Notifications (Sonner)

Positioned `bottom-right`. Themed with popover tokens. Custom icons from lucide:

```tsx
import { toast } from "sonner";

toast.success("Changes saved");
toast.error("Failed to save");
toast.promise(asyncFn(), {
  loading: "Saving...",
  success: "Saved!",
  error: "Failed to save",
});
```

Clipboard operations use a custom pattern:
```tsx
toast.success("Copied to clipboard", {
  icon: <ClipboardCheck className="size-4" />,
  description: value,
  classNames: { description: "font-mono" },
});
```

### Tab Routing

Settings and app detail pages use URL-synced tabs via `searchParams`:

```tsx
// Server component
const { tab } = await searchParams;
<Tabs defaultValue={tab || "variables"}>
  <TabsList variant="line">...</TabsList>
</Tabs>
```

Client components use `useSearchParams()` and `router.push` to update the tab query param without full page reload.

### Empty States

Consistent pattern: centered content in a dashed border container.

```tsx
<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
  <p className="text-sm text-muted-foreground">
    No projects yet. Create your first project to get started.
  </p>
  <Button size="sm" asChild>
    <Link href="/projects/new">
      <Plus className="mr-1.5 size-4" /> New Project
    </Link>
  </Button>
</div>
```

Simpler empty states use just `text-sm text-muted-foreground` (e.g. "No organizations yet.").

### Bottom Sheet Depth Effect

When a BottomSheet is open, `globals.css` scales main content to 97% and applies `rounded-t-2xl` corners + shadow, creating a layered depth effect. Background behind the scaled content is `oklch(0.05 0.005 260)`.

---

## Layout

### Overall Structure

```
<html>
  <body>
    <ThemeProvider defaultTheme="dark">
      {children}
      <Toaster position="bottom-right" />
    </ThemeProvider>
  </body>
</html>
```

### Authenticated App Layout (`app/(app)/layout.tsx`)

```
flex flex-col h-dvh bg-sidebar
  <TopNav />                    -- sticky header, bg-sidebar
  <main>                        -- flex-1 overflow-y-auto bg-background rounded-t-2xl
    mx-auto max-w-screen-xl px-5 py-8 lg:px-10
  </main>
<CommandPalette />
```

The main content area has `rounded-t-2xl` top corners, creating a "sheet over sidebar" visual where the sidebar color peeks through as a subtle header/content separator.

### Top Navigation (`components/layout/top-nav.tsx`)

Horizontal bar: brand (left), nav links (center), user menu (right). Constrained to `max-w-screen-xl`. Nav items are `rounded-lg px-3.5 py-2 text-sm font-medium`. Active state: `bg-sidebar-accent text-sidebar-accent-foreground`. Inactive: `text-sidebar-foreground/60`.

Navigation items: Projects, Metrics, Backups, Activity.

### Sidebar (Legacy)

A collapsible sidebar exists at `components/layout/sidebar.tsx` (60px collapsed, 240px expanded) but is not used in the current layout. The app uses `TopNav` instead. Sidebar components are still exported for potential future use.

### Mobile Sidebar

`components/layout/mobile-sidebar.tsx` -- uses shadcn Sheet (side="left", w-64). Contains SidebarNav, OrgSwitcher, and UserMenu. Triggered by a hamburger button visible at `lg:hidden`.

### Page Structure

Pages follow this structure:

```tsx
<div className="space-y-6">
  <PageToolbar actions={...}>
    <h1 className="text-2xl font-semibold tracking-tight">Title</h1>
    <OrgSwitcher ... />
  </PageToolbar>
  {/* Content */}
</div>
```

`space-y-6` is the standard vertical gap between page sections.

---

## Icons

### Icon Library

**Lucide React** (`lucide-react`) is the sole icon library. Common icons:

| Icon | Usage |
|---|---|
| `FolderKanban` | Projects navigation |
| `Cpu`, `MemoryStick`, `HardDrive`, `Network` | Metric indicators |
| `AlertTriangle` | Needs-redeploy warning |
| `Plus` | Create actions |
| `X` | Close/dismiss |
| `Loader2` | Loading spinner (always with `animate-spin`) |
| `Pencil`, `Trash2` | Edit/delete actions |
| `PanelLeft`, `PanelLeftClose` | Sidebar collapse/expand |
| `Menu` | Mobile menu trigger |
| `Moon`, `Sun` | Theme toggle |
| `Send`, `MessageSquare` | Discussion/comments |

### App Type Detection

`lib/ui/app-type.ts` matches app metadata (image name, git URL, deploy type, name) against regex patterns to detect technology type. Returns:

- `type` -- string identifier (e.g. "postgresql", "redis", "nextjs")
- `icon` -- URL from `cdn.simpleicons.org` with brand color
- `color` -- hex brand color

29 app types are detected (databases, frameworks, infrastructure tools). Fallbacks:

1. GitHub repos get the GitHub icon
2. Docker/compose deployments get the Docker icon
3. Unknown gets a zinc-400 colored dot

`lib/ui/project-icon.ts` delegates to `detectAppType` and returns just the icon URL.

### AppIcon Rendering

When an icon URL exists: faint brand-colored container (`{color}10`) + `<img>` at 70% opacity.

When no icon: faint container (`{color}20`) + solid colored dot.

Multi-app project cards show a 2x2 icon grid when 2+ apps have icons.

---

## Animations

### Built-in Keyframes

Defined in `globals.css` `@theme`:

- `shimmer-slide` -- horizontal shimmer effect (used by shimmer-button)
- `spin-around` -- 360-degree rotation with pauses (used by border-beam)
- `grid` -- vertical translate for grid backgrounds
- `marquee` / `marquee-vertical` -- scrolling text/content

### Transition Defaults

All interactive elements get `transition: background-color, color, box-shadow, transform` at `150ms ease-out-quart` via the base layer. Only active on hover-capable devices.

Hover effect on buttons: `filter: brightness(0.97)` -- subtle darkening rather than color change.

### Bottom Sheet Animations

- Open: `slide-in-from-bottom` at `--duration-normal` (250ms)
- Close: `slide-out-to-bottom` at `--duration-fast` (150ms)
- Easing: `--ease-out-expo` for natural deceleration
