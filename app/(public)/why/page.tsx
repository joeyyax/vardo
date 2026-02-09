"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { Section } from "@/components/marketing/section";
import { EASING } from "@/components/marketing/constants";
import {
  StaggerContainer,
  StaggerItem,
} from "@/components/marketing/animations";
import {
  ArrowRight,
  AlertCircle,
  Clock,
  FileText,
  Hash,
  Layers,
  Lightbulb,
  ListChecks,
  Receipt,
  Shield,
  Sparkles,
  Target,
  Wrench,
} from "lucide-react";

const JUGGLED_TOOLS = [
  { icon: Clock, label: "A time tracker", gradient: "#40a8ff" },
  { icon: ListChecks, label: "A task manager", gradient: "#9c40ff" },
  { icon: FileText, label: "A document tool", gradient: "#ffaa40" },
  { icon: Receipt, label: "An invoicing system", gradient: "#40ffaa" },
  {
    icon: Hash,
    label: "Unwritten rules in your head",
    gradient: "#ff6b40",
  },
];

const DESIGN_CHOICES = [
  {
    icon: Layers,
    label: "Fewer options",
    desc: "Less to configure, more to rely on",
    gradient: "#9c40ff",
  },
  {
    icon: Shield,
    label: "Clear boundaries",
    desc: "Everyone knows what's in scope",
    gradient: "#40a8ff",
  },
  {
    icon: Target,
    label: "Visible progress",
    desc: "No status meetings needed",
    gradient: "#ffaa40",
  },
  {
    icon: Lightbulb,
    label: "Explicit decisions",
    desc: "Nothing happens by accident",
    gradient: "#40ffaa",
  },
];

const REAL_WORK = [
  "Real client projects",
  "Real scope creep",
  "Real billing conversations",
  "Real frustration with duct-taped tools",
];

export default function WhyPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative pt-32 pb-20 sm:pb-28 px-4 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
        <div className="relative z-10 max-w-4xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.8, ease: EASING }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-8"
          >
            <Sparkles className="w-4 h-4" />
            <span>Our story</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            Why This Exists
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            Client work shouldn&apos;t feel harder than the work itself.
          </motion.p>
        </div>
      </section>

      {/* Too many moving parts */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <AlertCircle className="w-3.5 h-3.5" />
                The reality
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Too many moving parts
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Over time, most people end up juggling five or six tools that
                don&apos;t talk to each other. So you do the connecting —
                mentally, constantly.
              </p>
              <p className="text-lg font-medium">That gets exhausting.</p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              {JUGGLED_TOOLS.map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.4,
                    delay: i * 0.08,
                    ease: EASING,
                  }}
                  className={i === JUGGLED_TOOLS.length - 1 ? "col-span-2" : ""}
                >
                  <MagicCard
                    className="p-4 h-full"
                    gradientColor={`${item.gradient}20`}
                    gradientSize={120}
                    gradientFrom={item.gradient}
                    gradientTo={`${item.gradient}80`}
                  >
                    <div className="flex items-center gap-3">
                      <item.icon className="w-5 h-5 text-primary flex-shrink-0" />
                      <span className="text-sm font-medium">{item.label}</span>
                    </div>
                  </MagicCard>
                </motion.div>
              ))}
            </div>
          </div>
        </BlurFade>
      </Section>

      {/* The problem isn't discipline */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Shield className="w-3.5 h-3.5" />
              The real issue
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              The problem isn&apos;t discipline
            </h2>
            <p className="text-lg text-muted-foreground">
              Most freelancers and small teams aren&apos;t disorganized.
              They&apos;re working inside tools that weren&apos;t designed for
              how client work actually flows.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
            {[
              {
                label: "Fragmented",
                desc: "Time, tasks, and agreements treated as separate things",
              },
              {
                label: "Over-flexible",
                desc: "Optimized for options instead of clarity",
              },
              {
                label: "Implicit",
                desc: "Important decisions left unspoken and unrecorded",
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1, ease: EASING }}
              >
                <MagicCard className="p-5 text-center h-full" gradientSize={120}>
                  <h3 className="font-semibold mb-2">{item.label}</h3>
                  <p className="text-sm text-muted-foreground">{item.desc}</p>
                </MagicCard>
              </motion.div>
            ))}
          </div>

          <motion.p
            className="text-center text-lg font-medium mt-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
          >
            That&apos;s where friction comes from.
          </motion.p>
        </BlurFade>
      </Section>

      {/* A simpler idea */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Lightbulb className="w-3.5 h-3.5" />
                The insight
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                A simpler idea
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Work has a lifecycle. Proposals, agreements, onboarding,
                execution, billing — these are connected steps, not separate
                problems.
              </p>
              <p className="text-lg font-medium">
                When the system reflects that, everything gets easier.
              </p>
            </div>

            <StaggerContainer className="space-y-3">
              {[
                "Scope stays clear",
                "Work starts intentionally",
                "Billing feels obvious",
                "Clients feel informed instead of confused",
              ].map((item, i) => (
                <StaggerItem key={i}>
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-primary/5 border border-primary/10">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <span className="text-primary text-sm font-bold">
                        {i + 1}
                      </span>
                    </div>
                    <span className="text-sm font-medium">{item}</span>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </div>
        </BlurFade>
      </Section>

      {/* Opinionated, on purpose */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Target className="w-3.5 h-3.5" />
              Philosophy
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Opinionated, on purpose
            </h2>
            <p className="text-lg text-muted-foreground">
              This product doesn&apos;t try to support every workflow. It makes
              deliberate choices.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 max-w-4xl mx-auto">
            {DESIGN_CHOICES.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1, ease: EASING }}
              >
                <MagicCard
                  className="p-5 h-full"
                  gradientColor={`${item.gradient}20`}
                  gradientSize={150}
                  gradientFrom={item.gradient}
                  gradientTo={`${item.gradient}80`}
                >
                  <item.icon className="w-5 h-5 text-primary mb-3" />
                  <h3 className="font-semibold text-sm mb-1">{item.label}</h3>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </MagicCard>
              </motion.div>
            ))}
          </div>

          <motion.p
            className="text-center text-lg font-medium mt-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
          >
            Not because flexibility is bad — but because ambiguity is expensive.
          </motion.p>
        </BlurFade>
      </Section>

      {/* Built from real work */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Wrench className="w-3.5 h-3.5" />
                Origin
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Built from real work
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                This system wasn&apos;t designed on a whiteboard. It grew out of
                years of managing client projects, navigating scope creep, and
                patching tools together.
              </p>
              <p className="text-lg font-medium">
                It exists because the tools didn&apos;t.
              </p>
            </div>

            <StaggerContainer className="grid grid-cols-2 gap-3">
              {REAL_WORK.map((item, i) => (
                <StaggerItem key={i}>
                  <MagicCard className="p-4 h-full" gradientSize={100}>
                    <p className="text-sm font-medium">{item}</p>
                  </MagicCard>
                </StaggerItem>
              ))}
            </StaggerContainer>
          </div>
        </BlurFade>
      </Section>

      {/* The goal */}
      <Section size="large">
        <BlurFade>
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              The goal
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              The goal isn&apos;t to manage you
            </h2>
            <p className="text-lg text-muted-foreground mb-2">
              It&apos;s to give you a system that thinks about structure —
            </p>
            <p className="text-xl font-medium">
              so you can focus on the work.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Ready to try a calmer way to work?
          </h2>
          <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
            Starter is free forever. No card required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" asChild className="h-12 px-8 text-base">
              <Link href="/login">
                Get started free
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button variant="ghost" size="lg" asChild className="h-12 px-6">
              <Link href="/how-it-works">See how it works</Link>
            </Button>
          </div>
        </BlurFade>
      </Section>
    </>
  );
}
