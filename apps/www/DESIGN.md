# vardo.run Landing Page — Design Plan

## Overview

Single-page marketing site at `/` for vardo.run. Dark mode by default via Fumadocs theme. No new dependencies — Tailwind CSS v4, React 19, Next.js 16, and Fumadocs are already available. All components are local to `apps/www/components/landing/`.

Aesthetic targets: Linear, Vercel, Resend. Muted dark backgrounds, generous whitespace, sharp typography, monospace accents for code. No gimmicks.

## File structure

```
apps/www/
  app/
    page.tsx                  # Landing page composition
  components/
    landing/
      hero.tsx
      features.tsx
      how-it-works.tsx
      why-vardo.tsx
      install-cta.tsx
      footer.tsx
      terminal-block.tsx      # Reusable terminal/code display
      section.tsx             # Reusable section wrapper
```

## Design notes

### Colors

Use Fumadocs semantic tokens (already available via imported CSS):
- Backgrounds: `bg-background`, `bg-card`, `bg-muted`
- Text: `text-foreground` for headings, `text-muted-foreground` for body
- Borders: `border` class
- Accent: `bg-primary` / `text-primary` — sparingly, for CTAs

### Typography

- Hero heading: `text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight`
- Section headings: `text-3xl sm:text-4xl font-bold tracking-tight`
- Body: `text-lg text-muted-foreground`
- Code/terminal: `font-mono text-sm`

### Spacing

- Section padding: `py-24 sm:py-32`
- Container: `mx-auto max-w-6xl px-4 sm:px-6 lg:px-8`

### Effects

- Cards: `border border-border bg-card rounded-xl p-6` with `hover:border-primary/50 transition-colors duration-200`
- No parallax, no scroll-jacking, no particle backgrounds
- Terminal block: solid dark background with colored prompt character

## Section 1: Hero

**Layout:** `min-h-[85vh]`, centered content.

**Headline:** `Deploy on your server. Not someone else's.`

**Subheadline:** `Vardo is a self-hosted platform for deploying Docker apps. Push your code, get HTTPS, backups, and monitoring — without learning Kubernetes or paying for PaaS.`

**Elements:**
1. Headline (h1)
2. Subheadline (p)
3. Two CTAs: "Read the docs" (primary, `/docs`) + "View on GitHub" (outline)
4. Terminal block with install command and copy button:
   ```
   curl -fsSL https://vardo.run/install.sh | sudo bash
   ```

Terminal block looks like a real terminal — dark bg, monospace, macOS window chrome dots, copy button on hover.

## Section 2: Features

**Heading:** `Everything you need to run production apps`

**2x2 grid (single column mobile):**

1. **Deploy anything** — Push from Git, pull a Docker image, or paste a Compose file. Blue-green deployments with zero-downtime rollback.
2. **Domains and TLS** — Custom domains with automatic HTTPS via Let's Encrypt. Wildcard subdomains out of the box.
3. **Backups that just happen** — Automated volume snapshots to S3, R2, or B2. Tiered retention. One-click restore.
4. **Built-in monitoring** — Container metrics, log aggregation, and health checks. No Grafana stack required.

Cards: `bg-card border rounded-xl p-6`, inline SVG icons colored `text-primary`.

## Section 3: How it works

**Heading:** `From zero to production in three commands`

**3 columns (stack mobile):**

1. **Install** — One command sets up Vardo, Traefik, PostgreSQL, and Redis on your server.
   `curl -fsSL https://vardo.run/install.sh | sudo bash`
2. **Create a project** — Add your app from Git, a Docker image, or a template. Configure domains and env vars.
3. **Deploy** — Hit deploy. Vardo builds, health-checks, routes traffic, and provisions TLS. You're live.

Step numbers as large watermark-style `text-4xl font-bold text-primary/20`.

## Section 4: Why Vardo

**Heading:** `Built different`

**Two columns:** left has heading + paragraph, right has differentiator list.

**Paragraph:** Most self-hosted PaaS tools are either too simple (no backups, no monitoring) or too complex (Kubernetes in disguise). Vardo sits in the sweet spot: everything you need, nothing you don't.

**Differentiators:**
- **Docker Compose native** — No proprietary abstractions. Your compose files work as-is.
- **Own your infrastructure** — Your server, your data, your config. Export everything, move anywhere.
- **No vendor lock-in** — Every component is standard: Git, Docker, S3, WireGuard, Let's Encrypt.
- **Batteries included** — Backups, monitoring, TLS, environments, blue-green deploys. All built in.
- **One install, full stack** — Traefik, PostgreSQL, Redis, log aggregation. One command.

List items with `py-3 border-b border-border` separators.

## Section 5: Install CTA

**Background:** `bg-muted/50` band.

**Heading:** `Ready to deploy?`
**Subtext:** `One command. Five minutes. Your own PaaS.`

Terminal block (wider, `max-w-xl`):
```
curl -fsSL https://vardo.run/install.sh | sudo bash
```

Requirements note below: `Requires Ubuntu 22.04+ or Debian 12+. 1 GB RAM. A domain with DNS pointed to your server.`

Link: "See the full installation guide" → `/docs/installation`

## Section 6: Footer

Simple. `border-t border-border py-8`.

**Links:** Documentation, GitHub, Installation (inline, separated).
**Tagline:** `Vardo — your apps, your server, your rules.`

All `text-sm text-muted-foreground`.

## Responsive

| Breakpoint | Hero | Features | How it Works | Why Vardo |
|---|---|---|---|---|
| Mobile | Stack, text-4xl | Single column | Single column | Single column |
| Tablet | text-5xl | 2-column | 3-column | Two columns |
| Desktop | text-7xl, max-w-4xl | 2x2 grid | 3-column | Two columns |

## Animations

Minimal:
1. Copy button — icon swap clipboard → checkmark (200ms)
2. Card hover — `transition-colors duration-200` on border
3. Link hover — `transition-colors duration-150`
4. No scroll animations. Content is there when you scroll to it.

## Meta

- **Title:** Vardo — Self-hosted PaaS for Docker
- **Description:** Deploy Docker apps on your own server with automatic TLS, blue-green deployments, backups, and monitoring. No DevOps required.

## Implementation sequence

1. `section.tsx` + `terminal-block.tsx` (shared)
2. `hero.tsx`
3. `features.tsx`
4. `how-it-works.tsx`
5. `why-vardo.tsx`
6. `install-cta.tsx`
7. `footer.tsx`
8. Replace `app/page.tsx`
9. Test dark/light, responsive, clipboard
10. Verify links
