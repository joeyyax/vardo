"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { BentoCard, BentoGrid } from "@/components/ui/bento-grid";
import { cn } from "@/lib/utils";
import {
  Clock,
  ArrowRight,
  CheckCircle2,
  FileSignature,
  CheckSquare,
  Briefcase,
  Sparkles,
  Shield,
  Zap,
  Layout,
  Users,
  ArrowUpRight,
  Minus,
  Target,
  Eye,
  Workflow,
  Lightbulb,
} from "lucide-react";
import { EASING } from "@/components/marketing/constants";
import {
  AnimatedBackground,
  FloatingElement,
  StaggerContainer,
  StaggerItem,
} from "@/components/marketing/animations";
import { LifecycleBeam } from "@/components/marketing/lifecycle-beam";

function Section({
  children,
  className,
  size = "default",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "default" | "small" | "large";
}) {
  const padding = {
    default: "py-20 sm:py-28",
    small: "py-12 sm:py-16",
    large: "py-24 sm:py-32",
  };
  return (
    <section className={cn(padding[size], "px-4", className)}>
      <div className="max-w-5xl mx-auto">{children}</div>
    </section>
  );
}

export default function HomePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end start"],
  });

  const heroY = useTransform(scrollYProgress, [0, 1], [0, 100]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.3], [1, 0]);

  return (
    <div ref={containerRef}>

      {/* Hero */}
      <section className="relative min-h-screen flex flex-col items-center justify-center pt-24 pb-16 px-4 overflow-hidden">
        {/* Animated background */}
        <AnimatedBackground />
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />

        <motion.div
          style={{ y: heroY, opacity: heroOpacity }}
          className="relative z-10 max-w-4xl mx-auto text-center"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.8, ease: EASING }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-8"
          >
            <Sparkles className="w-4 h-4" />
            <span>Client work, simplified</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6"
          >
            Run client work
            <br />
            <span className="text-muted-foreground">without chaos.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground mb-6 max-w-2xl mx-auto"
          >
            Time tracking, tasks, proposals, invoicing — connected by default,
            not duct-taped together.
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.8, ease: EASING }}
            className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto mb-10"
          >
            <strong className="text-foreground">Scope</strong> is the workspace
            for freelancers and small teams who want structure without overhead.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.8, ease: EASING }}
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
          >
            <Button size="lg" asChild className="h-12 px-8 text-base">
              <Link href="/login">
                Get started free
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button variant="ghost" size="lg" asChild className="h-12 px-6">
              <Link href="/how-it-works">See how it works</Link>
            </Button>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.8 }}
            className="text-sm text-muted-foreground mt-6"
          >
            Free forever for solo use. No credit card required.
          </motion.p>
        </motion.div>

        {/* Hero visual — abstract dashboard wireframe */}
        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 1, ease: EASING }}
          className="relative z-10 w-full max-w-5xl mx-auto mt-16 px-4"
        >
          <motion.div
            animate={{ y: [0, -8, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            className="relative rounded-xl overflow-hidden border shadow-2xl bg-card"
          >
            <div className="absolute -inset-1 bg-gradient-to-r from-primary/20 via-primary/10 to-primary/20 blur-xl opacity-50" />
            <div className="relative aspect-[16/9] bg-gradient-to-br from-card via-card to-secondary/50 p-6 sm:p-10">
              {/* Stylised dashboard skeleton */}
              <div className="flex gap-4 h-full">
                {/* Sidebar */}
                <div className="hidden sm:flex flex-col gap-3 w-48 shrink-0">
                  <div className="h-8 w-24 rounded-md bg-primary/15" />
                  <div className="flex-1 space-y-2 mt-4">
                    <div className="h-4 w-full rounded bg-muted/60" />
                    <div className="h-4 w-3/4 rounded bg-primary/10" />
                    <div className="h-4 w-full rounded bg-muted/60" />
                    <div className="h-4 w-5/6 rounded bg-muted/60" />
                    <div className="h-4 w-2/3 rounded bg-muted/60" />
                  </div>
                </div>
                {/* Main content */}
                <div className="flex-1 space-y-4">
                  <div className="flex gap-3">
                    <div className="h-8 flex-1 rounded-md bg-muted/60" />
                    <div className="h-8 w-24 rounded-md bg-primary/20" />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="h-20 rounded-lg bg-primary/10 border border-primary/10" />
                    <div className="h-20 rounded-lg bg-muted/50" />
                    <div className="h-20 rounded-lg bg-muted/50" />
                  </div>
                  <div className="space-y-2 flex-1">
                    <div className="h-10 w-full rounded-md bg-muted/40" />
                    <div className="h-10 w-full rounded-md bg-muted/30" />
                    <div className="h-10 w-full rounded-md bg-muted/40" />
                    <div className="h-10 w-3/4 rounded-md bg-muted/30" />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </section>

      {/* Problem Recognition */}
      <Section className="bg-secondary/30 relative overflow-hidden">
        {/* Animated background blobs */}
        <motion.div
          className="absolute top-0 right-0 w-96 h-96 bg-primary/5 rounded-full blur-3xl"
          animate={{
            scale: [1, 1.2, 1],
            x: [0, 30, 0],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <motion.h2
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, ease: EASING }}
                className="text-3xl sm:text-4xl font-bold tracking-tight mb-6"
              >
                Client work gets messy fast
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.1, ease: EASING }}
                className="text-lg text-muted-foreground mb-8"
              >
                Structure erodes over time. Work rarely breaks because of
                effort—it breaks because the systems fail.
              </motion.p>

              <StaggerContainer className="space-y-4">
                {[
                  "Work starts before terms are clear",
                  "Tasks quietly expand scope",
                  "Time tracking lives in isolation",
                  "Billing feels reactive instead of inevitable",
                  "Tools are flexible, but disconnected",
                ].map((item, i) => (
                  <StaggerItem key={i}>
                    <motion.div
                      className="flex items-start gap-3 group cursor-default"
                      whileHover={{ x: 5 }}
                      transition={{ type: "spring", stiffness: 300 }}
                    >
                      <motion.span
                        className="text-muted-foreground/50 mt-1 group-hover:text-primary transition-colors"
                        initial={{ scale: 1 }}
                        whileHover={{ scale: 1.2, rotate: 90 }}
                      >
                        <Minus className="w-4 h-4" />
                      </motion.span>
                      <span className="text-foreground">{item}</span>
                    </motion.div>
                  </StaggerItem>
                ))}
              </StaggerContainer>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: 0.5, ease: EASING }}
                className="mt-8 text-muted-foreground"
              >
                If this feels familiar, it&apos;s not a personal failure.
                <br />
                <motion.span
                  className="text-foreground font-medium inline-block"
                  whileHover={{ scale: 1.02 }}
                >
                  It&apos;s a tooling problem.
                </motion.span>
              </motion.p>
            </div>

            {/* Abstract visual — scattered tool icons */}
            <motion.div
              className="relative"
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: EASING }}
            >
              <div className="aspect-square rounded-2xl bg-muted/50 border relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="grid grid-cols-3 gap-4 p-8 opacity-40">
                    {[Clock, CheckSquare, FileSignature, Users, Briefcase, Zap].map((Icon, i) => (
                      <motion.div
                        key={i}
                        className="w-14 h-14 rounded-xl bg-muted flex items-center justify-center"
                        animate={{ y: [0, -6, 0], rotate: [0, i % 2 === 0 ? 3 : -3, 0] }}
                        transition={{ duration: 4 + i * 0.5, repeat: Infinity, ease: "easeInOut", delay: i * 0.3 }}
                      >
                        <Icon className="w-6 h-6 text-muted-foreground" />
                      </motion.div>
                    ))}
                  </div>
                </div>
                {/* Dashed "missing connection" lines */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg">
                  <line x1="30%" y1="25%" x2="70%" y2="45%" stroke="currentColor" strokeWidth="1" strokeDasharray="6 4" className="text-muted-foreground/20" />
                  <line x1="65%" y1="30%" x2="35%" y2="70%" stroke="currentColor" strokeWidth="1" strokeDasharray="6 4" className="text-muted-foreground/20" />
                </svg>
              </div>
              <FloatingElement delay={0}>
                <div className="absolute -top-4 -right-4 w-20 h-20 bg-primary/10 rounded-xl" />
              </FloatingElement>
              <FloatingElement delay={1}>
                <div className="absolute -bottom-4 -left-4 w-16 h-16 bg-primary/5 rounded-full" />
              </FloatingElement>
            </motion.div>
          </div>
        </BlurFade>
      </Section>

      {/* The Difference - Magic Cards */}
      <Section className="relative">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <motion.h2
              className="text-3xl sm:text-4xl font-bold tracking-tight mb-6"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: EASING }}
            >
              A calmer way to work
            </motion.h2>
            <motion.p
              className="text-lg text-muted-foreground"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.1, ease: EASING }}
            >
              Most tools give you flexibility and leave you with the mess.
              <br />
              <strong className="text-foreground">
                Scope gives you structure — then gets out of the way.
              </strong>
            </motion.p>
          </div>

          <div className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {[
              {
                icon: Shield,
                title: "Opinionated workflows",
                desc: "Built-in guardrails that protect scope without getting in the way.",
                gradient: "#9c40ff",
              },
              {
                icon: Layout,
                title: "Clear visibility",
                desc: "Clients see progress without micromanaging your process.",
                gradient: "#40a8ff",
              },
              {
                icon: Zap,
                title: "Projects define rules",
                desc: "Set expectations once. Tasks execute inside clear boundaries.",
                gradient: "#ffaa40",
              },
              {
                icon: Sparkles,
                title: "Smart automation",
                desc: "Supports your judgment, never replaces it.",
                gradient: "#40ffaa",
              },
            ].map((feature, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.1, ease: EASING }}
                whileHover={{ y: -5 }}
              >
                <MagicCard
                  className="p-6 h-full"
                  gradientColor={`${feature.gradient}20`}
                  gradientSize={200}
                  gradientFrom={feature.gradient}
                  gradientTo={`${feature.gradient}80`}
                >
                  <div className="flex gap-4">
                    <motion.div
                      className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0"
                      whileHover={{ rotate: 10, scale: 1.1 }}
                      transition={{ type: "spring", stiffness: 300 }}
                    >
                      <feature.icon className="w-6 h-6 text-primary" />
                    </motion.div>
                    <div>
                      <h3 className="font-semibold mb-1">{feature.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>
                  </div>
                </MagicCard>
              </motion.div>
            ))}
          </div>

          <motion.div
            className="text-center mt-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
          >
            <motion.span
              className="inline-flex items-center gap-2 text-lg font-medium"
              whileHover={{ scale: 1.05 }}
            >
              One system, not a stack of duct-taped tools.
              <motion.span
                animate={{ x: [0, 5, 0] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <ArrowUpRight className="w-5 h-5" />
              </motion.span>
            </motion.span>
          </motion.div>
        </BlurFade>
      </Section>

      {/* Lifecycle */}
      <Section className="bg-secondary/30 relative overflow-hidden" size="large">
        {/* Background glow effects */}
        <motion.div
          className="absolute top-1/2 left-1/4 -translate-y-1/2 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none"
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.5, 0.8, 0.5],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
        <motion.div
          className="absolute top-1/2 right-1/4 -translate-y-1/2 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none"
          animate={{
            scale: [1.2, 1, 1.2],
            opacity: [0.5, 0.8, 0.5],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
            delay: 4,
          }}
        />

        <BlurFade>
          <div className="text-center mb-8">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Work has a lifecycle
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Client work follows a natural sequence.
              <br />
              <strong>Scope</strong> is built around it.
            </p>
          </div>

          {/* Lifecycle visual with animated beams */}
          <div className="mb-12">
            <LifecycleBeam />
          </div>

          {/* Lifecycle principles on Magic Cards */}
          <div className="grid sm:grid-cols-3 gap-4 sm:gap-6 max-w-4xl mx-auto">
            {[
              { principle: "Work doesn't start until it's agreed", icon: CheckCircle2 },
              { principle: "Scope doesn't change without intention", icon: Shield },
              { principle: "Everyone knows where things stand", icon: Sparkles },
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.5 + i * 0.1, ease: EASING }}
                className="group cursor-default"
              >
                <MagicCard
                  className="p-5 text-center"
                  gradientColor="rgba(var(--primary), 0.1)"
                  gradientSize={150}
                >
                  <item.icon className="w-5 h-5 text-primary mx-auto mb-2 opacity-70 group-hover:opacity-100 transition-opacity" />
                  <p className="font-medium text-sm sm:text-base">{item.principle}</p>
                </MagicCard>
              </motion.div>
            ))}
          </div>

          <motion.p
            className="text-center mt-12 text-lg font-medium"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.8 }}
          >
            Nothing is implicit. Nothing is surprising.
          </motion.p>
        </BlurFade>
      </Section>

      {/* Outcomes - Features with Hover-Activated Magic Cards */}
      <Section size="large">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <motion.h2
              className="text-3xl sm:text-4xl font-bold tracking-tight mb-4"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: EASING }}
            >
              What you get with Scope
            </motion.h2>
            <motion.p
              className="text-lg text-muted-foreground"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.1, ease: EASING }}
            >
              Everything you need to run client work, nothing you don&apos;t.
            </motion.p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {[
              {
                icon: Clock,
                title: "Time tracking that stays out of the way",
                description: "Keyboard-first, manual entry. No timers running in the background. Just capture what you did and move on.",
                gradient: "#40a8ff",
              },
              {
                icon: CheckSquare,
                title: "Tasks with clear boundaries",
                description: "A structured board that clients can see — without giving up workflow control.",
                gradient: "#9c40ff",
              },
              {
                icon: FileSignature,
                title: "Proposals and contracts that mean something",
                description: "Define scope before work starts. Clear acceptance, clear terms, no ambiguity.",
                gradient: "#ffaa40",
              },
              {
                icon: CheckCircle2,
                title: "Billing that follows naturally",
                description: "Time, scope, and expenses are already connected. Invoicing becomes a formality, not a project.",
                gradient: "#40ffaa",
              },
            ].map((feature, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: i * 0.1, ease: EASING }}
                whileHover={{ y: -8 }}
              >
                <MagicCard
                  className="overflow-hidden"
                  gradientColor={`${feature.gradient}15`}
                  gradientSize={300}
                  gradientFrom={feature.gradient}
                  gradientTo={`${feature.gradient}60`}
                >
                  <div className="aspect-[16/9] relative overflow-hidden bg-gradient-to-br from-muted/50 to-transparent flex items-center justify-center">
                    <motion.div
                      whileHover={{ scale: 1.1, rotate: 5 }}
                      transition={{ type: "spring", stiffness: 200 }}
                    >
                      <feature.icon className="w-16 h-16" style={{ color: `${feature.gradient}40` }} />
                    </motion.div>
                  </div>
                  <div className="p-6 relative">
                    <div className="flex items-center gap-3 mb-3">
                      <motion.div
                        className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"
                        whileHover={{ rotate: 10, scale: 1.1 }}
                        transition={{ type: "spring", stiffness: 300 }}
                      >
                        <feature.icon className="w-5 h-5 text-primary" />
                      </motion.div>
                      <h3 className="text-lg font-semibold">{feature.title}</h3>
                    </div>
                    <p className="text-muted-foreground leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Audience Fit - Bento Grid */}
      <Section className="bg-secondary/30 overflow-hidden">
        <BlurFade>
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Built for how you actually work
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              You don&apos;t need more features. You need clearer boundaries.
            </p>
          </div>

          <BentoGrid className="auto-rows-[minmax(180px,auto)] grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {/* Who it's for - Large card */}
            <BentoCard
              name="Scope is for"
              className="lg:col-span-2"
              background={
                <div className="absolute inset-0 flex items-center justify-center opacity-10">
                  <Users className="w-64 h-64 text-primary" />
                </div>
              }
              Icon={Users}
              description="Freelancers, consultants, small studios, and boutique agencies who know how to work but need better systems."
              href="/for-you"
              cta="See who it's for"
            />

            {/* If you value boundaries */}
            <BentoCard
              name="Care about boundaries"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Shield}
              description="Set clear limits without awkward conversations."
              href="/how-it-works"
              cta="Learn more"
            />

            {/* Know how to work */}
            <BentoCard
              name="Already know how to work"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Target}
              description="Tools that support your judgment, not replace it."
              href="/how-it-works"
              cta="Learn more"
            />

            {/* Tired of explaining */}
            <BentoCard
              name="Transparency without micromanagement"
              className="lg:col-span-2"
              background={
                <div className="absolute inset-0 flex items-center justify-center opacity-10">
                  <Eye className="w-48 h-48 text-primary" />
                </div>
              }
              Icon={Eye}
              description="Clients see progress without standing over your shoulder. Automated updates, clear status, no explanations needed."
              href="/how-it-works"
              cta="See how it works"
            />

            {/* Reduce thinking */}
            <BentoCard
              name="Reduce cognitive load"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Lightbulb}
              description="Clear structure means less decision fatigue."
              href="/pricing"
              cta="Get started"
            />

            {/* Workflow design */}
            <BentoCard
              name="Opinionated workflows"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Workflow}
              description="Built-in guardrails that protect scope without getting in the way."
              href="/how-it-works"
              cta="Learn more"
            />

            {/* Final CTA card */}
            <motion.div
              className="relative col-span-1 sm:col-span-2 lg:col-span-1 flex flex-col justify-center items-center p-6 rounded-xl bg-primary text-primary-foreground overflow-hidden group cursor-pointer"
              whileHover={{ scale: 1.02 }}
              transition={{ type: "spring", stiffness: 300 }}
            >
              <Link href="/login" className="absolute inset-0" />
              <Sparkles className="w-12 h-12 mb-4 group-hover:scale-110 transition-transform" />
              <h3 className="text-xl font-semibold mb-2">Ready?</h3>
              <p className="text-primary-foreground/80 text-sm text-center mb-4">
                Free forever for solo use. No credit card.
              </p>
              <div className="flex items-center gap-2 text-sm font-medium group-hover:gap-3 transition-all">
                Get started <ArrowRight className="w-4 h-4" />
              </div>
            </motion.div>
          </BentoGrid>
        </BlurFade>
      </Section>

      {/* Philosophy */}
      <Section>
        <BlurFade>
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-8">
              <Shield className="w-4 h-4" />
              <span>Our philosophy</span>
            </div>

            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-8">
              Opinionated by design
            </h2>

            <p className="text-lg text-muted-foreground mb-10">
              <strong className="text-foreground">Scope</strong> chooses:
            </p>

            <div className="grid sm:grid-cols-3 gap-6 mb-10">
              {[
                { label: "Clarity", over: "flexibility" },
                { label: "Structure", over: "configuration" },
                { label: "Calm", over: "cleverness" },
              ].map((choice, i) => (
                <div key={i} className="text-center">
                  <div className="text-2xl font-bold text-foreground mb-1">
                    {choice.label}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    over {choice.over}
                  </div>
                </div>
              ))}
            </div>

            <p className="text-lg font-medium">
              Because client work already has enough uncertainty.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* Personal Projects - Compact Callout */}
      <Section className="bg-secondary/30" size="small">
        <BlurFade>
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Briefcase className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">Internal work is measured, not billed</h3>
                <p className="text-sm text-muted-foreground">
                  Not all work is client work — and it still counts.
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground max-w-md text-center md:text-right">
              Planning, admin, marketing, learning — tracked the same way,
              visible in reports, always free. Understanding effort vs revenue
              is how you make better decisions.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* Final CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <div className="max-w-2xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              Your tools should feel lighter
              <br />
              <span className="text-muted-foreground">
                than the work itself.
              </span>
            </h2>

            <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
              Start with Starter — it&apos;s free forever, no credit card
              required. Upgrade when your client work grows.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button size="lg" asChild className="h-12 px-8 text-base">
                <Link href="/login">
                  Get started free
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
              <Button variant="ghost" size="lg" asChild className="h-12 px-6">
                <Link href="/pricing">See pricing</Link>
              </Button>
            </div>
          </div>
        </BlurFade>
      </Section>
    </div>
  );
}
