"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform, useSpring, useMotionValue, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { Marquee } from "@/components/ui/marquee";
import { cn } from "@/lib/utils";
import {
  Clock,
  ArrowRight,
  Keyboard,
  Receipt,
  BarChart3,
  FolderKanban,
  Zap,
  Check,
  Command,
  MousePointer2,
  Type,
  DollarSign,
  Layers,
  Sparkles,
  FileSignature,
  Wallet,
  Users,
  ChevronRight,
  Terminal,
  Code2,
  GitBranch,
  Calendar,
} from "lucide-react";

const EASING = {
  smooth: [0.25, 0.1, 0.25, 1] as const,
  snappy: [0.16, 1, 0.3, 1] as const,
  bounce: [0.68, -0.55, 0.265, 1.55] as const,
};

function CommandBadge({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: EASING.snappy }}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-secondary border text-[10px] sm:text-xs font-mono text-muted-foreground"
    >
      <Command className="w-3 h-3" />
      {text}
    </motion.span>
  );
}

function FloatingCard({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const y = useMotionValue(0);
  const springY = useSpring(y, { stiffness: 100, damping: 20 });

  useEffect(() => {
    const interval = setInterval(() => {
      y.set(Math.sin(Date.now() / 1000 + delay) * 8);
    }, 50);
    return () => clearInterval(interval);
  }, [y, delay]);

  return (
    <motion.div
      style={{ y: springY }}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.8, ease: EASING.snappy }}
      className={cn("bg-card border rounded-xl shadow-xl shadow-black/5", className)}
    >
      {children}
    </motion.div>
  );
}

function GlowingButton({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const isPrimary = variant === "primary";

  return (
    <Link href={href}>
      <motion.div
        className={cn(
          "relative group cursor-pointer",
          isPrimary ? "rounded-full" : "rounded-lg"
        )}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        {isPrimary && (
          <div className="absolute -inset-[1px] rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-amber-500 opacity-70 blur-sm group-hover:opacity-100 transition-opacity" />
        )}
        <div
          className={cn(
            "relative flex items-center justify-center gap-2 font-medium",
            isPrimary
              ? "h-12 px-8 bg-foreground text-background rounded-full"
              : "h-12 px-6 bg-secondary text-secondary-foreground rounded-lg border hover:bg-secondary/80"
          )}
        >
          {children}
        </div>
      </motion.div>
    </Link>
  );
}

function FeatureRow({
  icon: Icon,
  title,
  description,
  code,
  reversed = false,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  code?: string;
  reversed?: boolean;
}) {
  return (
    <div className={cn("grid lg:grid-cols-2 gap-8 lg:gap-16 items-center", reversed && "lg:grid-flow-col-dense")}>
      <div className={cn("space-y-4", reversed && "lg:col-start-2")}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Icon className="w-5 h-5 text-primary" />
          </div>
        </div>
        <h3 className="text-2xl sm:text-3xl font-bold tracking-tight">{title}</h3>
        <p className="text-lg text-muted-foreground leading-relaxed">{description}</p>
      </div>
      <div className={cn(reversed && "lg:col-start-1")}>
        {code ? (
          <div className="bg-muted rounded-2xl p-1 overflow-hidden">
            <div className="bg-card border rounded-xl p-4 font-mono text-sm overflow-x-auto">
              <div className="flex gap-1.5 mb-3">
                <div className="w-3 h-3 rounded-full bg-red-500/20" />
                <div className="w-3 h-3 rounded-full bg-amber-500/20" />
                <div className="w-3 h-3 rounded-full bg-green-500/20" />
              </div>
              <pre className="text-muted-foreground">
                <code>{code}</code>
              </pre>
            </div>
          </div>
        ) : (
          <div className="relative aspect-video bg-gradient-to-br from-secondary to-muted rounded-2xl overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center">
              <Icon className="w-24 h-24 text-primary/10" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const testimonials = [
  { name: "Sarah Chen", role: "DevOps Consultant", text: "Finally, time tracking that doesn't make me want to kms" },
  { name: "Marcus Johnson", role: "Full-stack Dev", text: "The keyboard shortcuts are *chef's kiss*" },
  { name: "Alex Rivera", role: "Freelance Designer", text: "Replaced Toggl, Harvest, AND my spreadsheet. Finally." },
  { name: "Jordan Park", role: "Indie Hacker", text: "Built by someone who actually understands solo devs" },
  { name: "Taylor Kim", role: "Frontend Engineer", text: "The CLI tool changed everything for me" },
  { name: "Casey Martinez", role: "Consultant", text: "No more 'wait did I track that meeting?' moments" },
];

export default function HomePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"],
  });

  const y = useTransform(scrollYProgress, [0, 1], [0, 150]);
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.95]);

  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <div ref={containerRef} className="relative min-h-screen bg-background text-foreground overflow-x-hidden">
      {/* Ambient glow that follows mouse */}
      <motion.div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `radial-gradient(600px circle at ${mousePos.x}px ${mousePos.y}px, hsl(var(--primary) / 0.08), transparent 40%)`,
        }}
      />

      {/* Header */}
      <motion.header
        className="fixed top-0 left-0 right-0 z-50 border-b bg-background/50 backdrop-blur-xl"
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.6, ease: EASING.snappy }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center group-hover:scale-110 transition-transform">
              <Clock className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg">Time</span>
          </Link>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button size="sm" className="bg-foreground text-background hover:bg-foreground/90" asChild>
              <Link href="/login">Get started</Link>
            </Button>
          </div>
        </div>
      </motion.header>

      {/* Hero */}
      <section className="relative min-h-screen flex flex-col items-center justify-center pt-32 pb-20 px-4">
        <motion.div style={{ y, opacity, scale }} className="relative z-10 max-w-5xl mx-auto text-center">
          {/* Eyebrow */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASING.snappy }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border bg-secondary/50 text-sm mb-8"
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            Free for solo freelancers
          </motion.div>

          {/* Main headline */}
          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.8, ease: EASING.snappy }}
            className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter mb-6"
          >
            Run your freelance
            <br />
            <span className="text-muted-foreground">business from</span>
            <br />
            <span className="bg-gradient-to-r from-amber-600 via-orange-600 to-amber-600 bg-clip-text text-transparent">
              one damn place.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6, ease: EASING.snappy }}
            className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10"
          >
            Clients, projects, proposals, time, expenses, invoices. No more
            tab-switching hell. Built for developers who want their tools to
            work like their editor.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.6, ease: EASING.snappy }}
            className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16"
          >
            <GlowingButton href="/login">
              Start tracking free
              <ArrowRight className="w-4 h-4" />
            </GlowingButton>
            <a
              href="#features"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              See how it works
              <ChevronRight className="w-4 h-4" />
            </a>
          </motion.div>

          {/* Keyboard shortcuts demo */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.4, duration: 0.6, ease: EASING.snappy }}
            className="flex flex-wrap justify-center gap-2 mb-20"
          >
            <CommandBadge text="K" delay={0.5} />
            <span className="text-xs text-muted-foreground self-center">to open command palette</span>
            <span className="hidden sm:inline text-muted-foreground/30">·</span>
            <kbd className="px-1.5 py-0.5 rounded bg-secondary border text-[10px] sm:text-xs font-mono text-muted-foreground">Tab</kbd>
            <span className="text-xs text-muted-foreground self-center">to navigate</span>
            <span className="hidden sm:inline text-muted-foreground/30">·</span>
            <kbd className="px-1.5 py-0.5 rounded bg-secondary border text-[10px] sm:text-xs font-mono text-muted-foreground">⌘ Enter</kbd>
            <span className="text-xs text-muted-foreground self-center">to save</span>
          </motion.div>

          {/* Floating UI mockup */}
          <div className="relative max-w-3xl mx-auto">
            <FloatingCard className="bg-card/95 backdrop-blur border" delay={0.6}>
              <div className="p-4 border-b">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Terminal className="w-4 h-4" />
                  <span className="text-sm font-mono">track — Log your work</span>
                </div>
              </div>
              <div className="p-4 space-y-4">
                {/* Entry row */}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 border">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">Refactored auth flow</div>
                    <div className="text-xs text-muted-foreground">Acme Corp / Backend</div>
                  </div>
                  <span className="text-sm font-mono text-muted-foreground">2.5h</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">$</span>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50 border">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">Design system updates</div>
                    <div className="text-xs text-muted-foreground">Startup Inc / Frontend</div>
                  </div>
                  <span className="text-sm font-mono text-muted-foreground">4h</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">$</span>
                </div>
                {/* Input row */}
                <div className="flex items-center gap-2 p-3 rounded-lg border border-primary/30 bg-primary/5">
                  <div className="flex-1 flex items-center gap-2">
                    <Type className="w-4 h-4 text-primary" />
                    <span className="text-sm text-primary">API documentation review</span>
                    <span className="text-primary animate-pulse">|</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Acme</span>
                    <span className="text-xs text-muted-foreground">/</span>
                    <span className="text-xs text-primary">Dev</span>
                    <span className="px-2 py-0.5 rounded bg-background border text-sm font-mono">1.5h</span>
                  </div>
                  <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
                    <ArrowRight className="w-4 h-4 text-primary-foreground" />
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 bg-secondary/30 border-t flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-3">
                  <span>3 entries today</span>
                  <span className="text-border">|</span>
                  <span>8h 15m total</span>
                </div>
                <span className="font-mono">ESC to cancel</span>
              </div>
            </FloatingCard>

            {/* Floating elements */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1, duration: 0.6, ease: EASING.snappy }}
              className="absolute -left-4 lg:-left-16 top-1/4 hidden sm:block"
            >
              <FloatingCard className="p-3 bg-amber-500/10 border-amber-500/20" delay={0}>
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium">$2,450</span>
                </div>
                <div className="text-xs text-muted-foreground">billed this month</div>
              </FloatingCard>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.1, duration: 0.6, ease: EASING.snappy }}
              className="absolute -right-4 lg:-right-16 top-1/3 hidden sm:block"
            >
              <FloatingCard className="p-3 bg-green-500/10 border-green-500/20" delay={1}>
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-green-600" />
                  <span className="text-sm font-medium">47h</span>
                </div>
                <div className="text-xs text-muted-foreground">tracked this week</div>
              </FloatingCard>
            </motion.div>
          </div>
        </motion.div>

        {/* Gradient fade at bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
      </section>

      {/* Why devs love it */}
      <section id="features" className="py-24 sm:py-32 px-4">
        <div className="max-w-7xl mx-auto">
          <BlurFade>
            <div className="text-center mb-16 sm:mb-24">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-4">
                Everything you need. Nothing you don't.
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Proposals, contracts, time tracking, expenses, invoices—wired together
                in a UI that feels like your favorite code editor.
              </p>
            </div>
          </BlurFade>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: FileSignature,
                title: "Proposals & Contracts",
                description: "Send professional proposals, convert to contracts in one click, collect e-signatures.",
                shortcut: "Proposals",
              },
              {
                icon: Keyboard,
                title: "Keyboard-first time entry",
                description: "Track time without touching your mouse. Tab through fields, ⌘Enter to save.",
                shortcut: "⌘ + K",
              },
              {
                icon: Receipt,
                title: "Invoicing that just works",
                description: "Generate from entries in seconds. Send PDFs or public links. Get paid.",
                shortcut: "Invoices",
              },
              {
                icon: Wallet,
                title: "Track expenses",
                description: "Log costs, attach receipts, mark as billable. Include on invoices automatically.",
                shortcut: "Expenses",
              },
              {
                icon: Layers,
                title: "Smart everything",
                description: "AI suggestions, rate inheritance, drag-and-drop organization. It just works.",
                shortcut: "Tab → Tab",
              },
              {
                icon: BarChart3,
                title: "Reports clients love",
                description: "Shareable breakdowns with hours by project. Toggle rates per-client. Auto-send weekly.",
                shortcut: "Reports",
              },
            ].map((feature, i) => (
              <BlurFade key={feature.title} delay={0.05 * i}>
                <motion.div
                  className="group h-full p-6 rounded-2xl border bg-card hover:bg-accent/50 transition-colors"
                  whileHover={{ y: -4 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
                      <feature.icon className="w-5 h-5 text-primary" />
                    </div>
                    {feature.shortcut && (
                      <kbd className="px-2 py-1 rounded bg-secondary border text-[10px] font-mono text-muted-foreground">
                        {feature.shortcut}
                      </kbd>
                    )}
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </motion.div>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* The Workflow */}
      <section className="py-24 sm:py-32 px-4 bg-secondary/30">
        <div className="max-w-7xl mx-auto">
          <BlurFade>
            <div className="text-center mb-16">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-4">
                The complete workflow.
              </h2>
              <p className="text-lg text-muted-foreground">
                Win the client. Do the work. Send the invoice. All in one place.
              </p>
            </div>
          </BlurFade>

          <div className="space-y-24 sm:space-y-32">
            <FeatureRow
              icon={FolderKanban}
              title="Clients, projects, tasks"
              description="Nested clients for agencies (Agency → End Client). Projects with tasks, budgets, and estimates. Rates cascade: org → client → project → task. Drag-and-drop to reorganize your world."
              code={`Organization
├── Client: Acme Corp (rate: $125/hr)
│   └── Project: Website Redesign
│       ├── Task: API Development
│       └── Task: Frontend (rate: $150/hr)
└── Client: Beta Inc
    └── Project: Monthly Retainer`}
            />

            <FeatureRow
              icon={FileSignature}
              title="Proposals & contracts"
              description="Create professional proposals with scope, timeline, and pricing. Convert approved proposals to contracts instantly. Collect e-signatures. Projects auto-create when contracts are signed."
              code={`Proposal #2025-012
Acme Corp / Website Redesign
━━━━━━━━━━━━━━━━
Scope: Full redesign, CMS, launch
Timeline: 6 weeks
Pricing: Flat fee $12,500

[View Proposal] → [Approve] → [Contract]`}
              reversed
            />

            <FeatureRow
              icon={Clock}
              title="Track time, your way"
              description="No ticking timers demanding attention. Log time after the fact—or batch it at day's end. Smart duration parsing: 1.5, 1h30m, 90m all work. Smart suggestions learn your patterns."
              code={`# Keyboard-first entry
Tab → "API work" → Tab → Tab → ⌘Enter

✓ Logged 2.5h to Acme / API Development
  Description: "API work"
  Suggested because: "You usually work on
  backend stuff on Tuesday mornings"`}
            />

            <FeatureRow
              icon={Wallet}
              title="Track expenses"
              description="Log costs with receipts. Attach to clients for pass-through billing. Mark subscriptions as recurring. Include on invoices with optional markup. Never miss a reimbursable again."
              code={`Expenses — Acme Corp
━━━━━━━━━━━━━━━━
Adobe CC (Software)        $54.99/mo  💰
Stock photos (Assets)      $29.00     💰
Domain renewal (Hosting)   $14.99     ✗
Client lunch (Meals)       $68.50     💰

💰 = Billable to client`}
              reversed
            />

            <FeatureRow
              icon={Receipt}
              title="Invoice without work"
              description="Generate invoices from time + expenses in seconds. Public links clients can view (no login). Auto-generate on your schedule. Track when they're viewed. Hourly, retainer, capped, fixed—you name it."
              code={`Invoice #2025-023
Acme Corp — Feb 1-28, 2025
━━━━━━━━━━━━━━━━
Website Redesign    32h × $125   $4,000
Bug fixes           2.5h × $125    $312
Expenses (4 items)             $152
━━━━━━━━━━━━━━━━
Total                         $4,464`}
            />

            <FeatureRow
              icon={BarChart3}
              title="Reports that impress"
              description="Shareable links with beautiful breakdowns by project and task. Your clients see exactly what they're paying for. Toggle rate visibility per-client. Export to CSV or PDF. Weekly auto-reports keep everyone aligned."
              reversed
            />
          </div>
        </div>
      </section>

      {/* Testimonials Marquee */}
      <section className="py-24 overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 mb-12">
          <BlurFade>
            <h2 className="text-2xl sm:text-3xl font-bold text-center">Loved by solo operators</h2>
          </BlurFade>
        </div>

        <div className="relative">
          <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-background to-transparent z-10" />
          <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-background to-transparent z-10" />

          <Marquee className="py-4" pauseOnHover>
            {testimonials.map((t) => (
              <div
                key={t.name}
                className="w-72 p-5 rounded-xl border bg-card mx-3"
              >
                <p className="text-sm mb-4 text-muted-foreground">&ldquo;{t.text}&rdquo;</p>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
                    {t.name[0]}
                  </div>
                  <div>
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </Marquee>
        </div>
      </section>

      {/* Pricing / CTA */}
      <section className="py-24 sm:py-32 px-4">
        <div className="max-w-4xl mx-auto">
          <BlurFade>
            <div className="relative rounded-3xl border bg-card overflow-hidden">
              {/* Background glow */}
              <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />

              <div className="relative p-8 sm:p-12 text-center">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 text-amber-600 text-sm font-medium mb-6">
                  <Sparkles className="w-4 h-4" />
                  Free forever for solo users
                </div>

                <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight mb-4">
                  Stop fighting your tools.
                </h2>
                <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
                  Time tracking shouldn't feel like a second job. Get started free,
                  upgrade only when you need team features.
                </p>

                <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-12">
                  <GlowingButton href="/login">
                    Start free
                    <ArrowRight className="w-4 h-4" />
                  </GlowingButton>
                </div>

                <div className="grid sm:grid-cols-3 gap-6 text-left max-w-2xl mx-auto">
                  {[
                    { icon: Check, text: "Unlimited time entries" },
                    { icon: Check, text: "Unlimited clients & projects" },
                    { icon: Check, text: "Full API access" },
                    { icon: Check, text: "Invoicing included" },
                    { icon: Check, text: "CSV & PDF exports" },
                    { icon: Check, text: "Email support" },
                  ].map((item) => (
                    <div key={item.text} className="flex items-center gap-2 text-sm">
                      <item.icon className="w-4 h-4 text-primary" />
                      <span className="text-muted-foreground">{item.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </BlurFade>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
                  <Clock className="w-3.5 h-3.5 text-primary-foreground" />
                </div>
                <span className="font-semibold">Time</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Time tracking for freelancers who hate time tracking.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link href="/track" className="hover:text-foreground">Track</Link></li>
                <li><Link href="/invoices" className="hover:text-foreground">Invoices</Link></li>
                <li><Link href="/reports" className="hover:text-foreground">Reports</Link></li>
                <li><Link href="/api" className="hover:text-foreground">API Docs</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link href="/about" className="hover:text-foreground">About</Link></li>
                <li><Link href="/blog" className="hover:text-foreground">Blog</Link></li>
                <li><Link href="/changelog" className="hover:text-foreground">Changelog</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-sm">Legal</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link href="/privacy" className="hover:text-foreground">Privacy</Link></li>
                <li><Link href="/terms" className="hover:text-foreground">Terms</Link></li>
              </ul>
            </div>
          </div>
          <div className="pt-8 border-t flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Built with irritation, shipped with relief.
            </p>
            <div className="flex items-center gap-4">
              <a href="https://github.com" className="text-muted-foreground hover:text-foreground">
                <GitBranch className="w-5 h-5" />
              </a>
              <a href="https://twitter.com" className="text-muted-foreground hover:text-foreground">
                <MousePointer2 className="w-5 h-5" />
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
