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
  Check,
  Compass,
  ExternalLink,
  Sparkles,
  X,
} from "lucide-react";

const GOOD_FIT = [
  {
    label: "You do client work",
    desc: "Freelance, consulting, agency — work with external clients is your core.",
  },
  {
    label: "You care about scope",
    desc: "Clear boundaries matter to you. Scope creep is something you actively manage.",
  },
  {
    label: "You prefer structure over configuration",
    desc: "You want a system that works out of the box, not one you have to design yourself.",
  },
  {
    label: "You want fewer decisions, not more",
    desc: "Decision fatigue is real. You want the tool to handle the small stuff.",
  },
  {
    label: "You work solo or in a small team",
    desc: "1-10 people. Everyone wears multiple hats. You need calm, not enterprise.",
  },
];

const NOT_FIT = [
  {
    label: "Deep accounting features",
    desc: "Scope handles invoicing, not bookkeeping.",
  },
  {
    label: "Large team management",
    desc: "Built for small teams, not departments.",
  },
  {
    label: "Custom workflow design",
    desc: "Opinionated by design. Not infinitely configurable.",
  },
  {
    label: "Client-managed tasks",
    desc: "Clients see progress. They don't manage the board.",
  },
  {
    label: "Highly customizable systems",
    desc: "Structure over configuration, every time.",
  },
];

const ALTERNATIVES = [
  {
    name: "Wave",
    bestFor:
      "Accounting, invoicing, and financial reporting. Wave shines once the work is already done — it picks up where Scope leaves off.",
    gradient: "#40a8ff",
  },
  {
    name: "Asana / Monday / Workamajig",
    bestFor:
      "Large teams, multiple departments, complex workflows and permissions. These tools excel at coordination at scale — a different problem than what Scope solves.",
    gradient: "#9c40ff",
  },
  {
    name: "Toggl",
    bestFor:
      "Standalone time tracking with minimal overhead. If you only need a timer and reports, Toggl is excellent at exactly that.",
    gradient: "#ffaa40",
  },
];

export default function ChoosingTheRightToolPage() {
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
            <Compass className="w-4 h-4" />
            <span>Finding the right fit</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            There&apos;s no &ldquo;best&rdquo; tool.
            <br />
            <span className="text-muted-foreground">Only the right one.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            Scope is intentionally opinionated. That means it works extremely
            well in some cases — and not at all in others.
          </motion.p>
        </div>
      </section>

      {/* Good fit */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Check className="w-3.5 h-3.5" />
              Great fit
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Scope is a great fit if
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto">
            {GOOD_FIT.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: EASING }}
                whileHover={{ y: -4 }}
                className={i === 4 ? "sm:col-span-2 lg:col-span-1" : ""}
              >
                <MagicCard
                  className="p-5 h-full"
                  gradientColor="#40ffaa20"
                  gradientSize={150}
                  gradientFrom="#40ffaa"
                  gradientTo="#40ffaa80"
                >
                  <div className="flex items-start gap-3">
                    <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-sm mb-1">
                        {item.label}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {item.desc}
                      </p>
                    </div>
                  </div>
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
            If this sounds like you, Scope will probably feel calm and obvious.
          </motion.p>
        </BlurFade>
      </Section>

      {/* Not a fit */}
      <Section size="large">
        <BlurFade>
          <div className="max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-xs font-medium mb-4">
              <X className="w-3.5 h-3.5" />
              Honest about fit
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-8">
              Probably not the right fit if you need
            </h2>

            <StaggerContainer className="space-y-3">
              {NOT_FIT.map((item, i) => (
                <StaggerItem key={i}>
                  <div className="flex items-start gap-4 p-4 rounded-lg bg-muted/50 border border-border">
                    <X className="w-5 h-5 text-muted-foreground/40 flex-shrink-0 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-sm mb-1">
                        {item.label}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                </StaggerItem>
              ))}
            </StaggerContainer>

            <motion.p
              className="text-lg font-medium mt-8"
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.5 }}
            >
              That&apos;s not a failure — it&apos;s a signal.
            </motion.p>
          </div>
        </BlurFade>
      </Section>

      {/* Alternatives */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <ExternalLink className="w-3.5 h-3.5" />
              Alternatives
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              If Scope isn&apos;t right, here are good options
            </h2>
            <p className="text-lg text-muted-foreground">
              We&apos;d rather you use the right tool than use Scope poorly.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {ALTERNATIVES.map((tool, i) => (
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
                  gradientColor={`${tool.gradient}20`}
                  gradientSize={200}
                  gradientFrom={tool.gradient}
                  gradientTo={`${tool.gradient}80`}
                >
                  <h3 className="text-lg font-semibold mb-3">{tool.name}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {tool.bestFor}
                  </p>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Takeaway */}
      <Section size="large">
        <BlurFade>
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              The takeaway
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              Choosing the right tool is part of doing good work
            </h2>
            <p className="text-lg text-muted-foreground mb-4">
              Scope is for people who want clear intent, calm execution, and
              work that stays inside its boundaries.
            </p>
            <p className="text-lg text-muted-foreground">
              If that&apos;s not you, that&apos;s okay. We built this for a
              specific kind of work — and we&apos;d rather be honest about it.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Think Scope might be right?
          </h2>
          <p className="text-lg text-muted-foreground mb-8 max-w-xl mx-auto">
            Starter is free. No card required.
          </p>
          <Button size="lg" asChild className="h-12 px-8 text-base">
            <Link href="/login">
              Build your workflow
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </BlurFade>
      </Section>
    </>
  );
}
