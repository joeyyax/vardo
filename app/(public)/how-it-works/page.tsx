"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { Section } from "@/components/marketing/section";
import { EASING } from "@/components/marketing/constants";
import { LifecycleBeam } from "@/components/marketing/lifecycle-beam";
import {
  StaggerContainer,
  StaggerItem,
} from "@/components/marketing/animations";
import {
  ArrowRight,
  Briefcase,
  CheckCircle2,
  Eye,
  EyeOff,
  Layers,
  ListChecks,
  MessageSquare,
  Send,
  Shield,
  Sparkles,
  ThumbsUp,
  Zap,
} from "lucide-react";

export default function HowItWorksPage() {
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
            <span>Product overview</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            Intentional from
            <br />
            <span className="text-muted-foreground">start to finish.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            Scope connects proposals, tasks, time, and billing into one clear
            system — so nothing falls through the cracks.
          </motion.p>
        </div>
      </section>

      {/* Projects define the rules */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Layers className="w-3.5 h-3.5" />
                Foundation
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Everything starts with a project
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Projects aren&apos;t folders — they&apos;re contracts. Every
                project defines what work is happening, what it costs, when
                it&apos;s due, and what everyone expects.
              </p>
              <p className="text-lg font-medium">
                Nothing important happens without a clear container.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {[
                {
                  icon: Shield,
                  label: "Scope",
                  desc: "What's included and what's not",
                  gradient: "#9c40ff",
                },
                {
                  icon: Layers,
                  label: "Pricing",
                  desc: "Rates, estimates, and billing terms",
                  gradient: "#40a8ff",
                },
                {
                  icon: ListChecks,
                  label: "Timelines",
                  desc: "Start dates, milestones, deadlines",
                  gradient: "#ffaa40",
                },
                {
                  icon: CheckCircle2,
                  label: "Expectations",
                  desc: "Deliverables, approvals, hand-offs",
                  gradient: "#40ffaa",
                },
              ].map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{
                    duration: 0.5,
                    delay: i * 0.1,
                    ease: EASING,
                  }}
                >
                  <MagicCard
                    className="p-5 h-full"
                    gradientColor={`${item.gradient}20`}
                    gradientSize={150}
                    gradientFrom={item.gradient}
                    gradientTo={`${item.gradient}80`}
                  >
                    <item.icon className="w-5 h-5 text-primary mb-3" />
                    <h3 className="font-semibold text-sm mb-1">
                      {item.label}
                    </h3>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </MagicCard>
                </motion.div>
              ))}
            </div>
          </div>
        </BlurFade>
      </Section>

      {/* Tasks stay in their lane */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <ListChecks className="w-3.5 h-3.5" />
              Execution
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Tasks stay in their lane
            </h2>
            <p className="text-lg text-muted-foreground">
              Tasks are how work gets done — but they don&apos;t redefine what
              the work is. They live inside projects, inherit their rules, and
              move without disrupting the bigger picture.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {[
              {
                label: "Scoped",
                desc: "Every task belongs to a project. No orphans.",
              },
              {
                label: "Bounded",
                desc: "Tasks don't redefine scope or change billing.",
              },
              {
                label: "Explicit",
                desc: "Work doesn't start until someone says it does.",
              },
              {
                label: "Visible",
                desc: "Clients see task progress without managing it.",
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
            Tasks move. Projects advance deliberately.
          </motion.p>
        </BlurFade>
      </Section>

      {/* Lifecycle */}
      <Section
        className="bg-secondary/30 relative overflow-hidden"
        size="large"
        width="wide"
      >
        <BlurFade>
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              Lifecycle
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Work follows a natural sequence
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Proposal, agreement, onboarding, active work, ongoing or
              wrap-up. The system respects this order — transitions are explicit,
              nothing is assumed.
            </p>
          </div>

          <LifecycleBeam />

          <div className="grid sm:grid-cols-3 gap-4 max-w-3xl mx-auto mt-8">
            {[
              "Work doesn't start until it's agreed",
              "Transitions are explicit, not accidental",
              "Everyone knows where things stand",
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.5 + i * 0.1, ease: EASING }}
              >
                <MagicCard className="p-4 text-center" gradientSize={120}>
                  <p className="text-sm font-medium">{item}</p>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Client visibility */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Eye className="w-3.5 h-3.5" />
                Collaboration
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Clients see progress, not process
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Clients stay informed without standing over your shoulder. They
                see what matters, comment when needed, and approve at the right
                moments — without managing your workflow.
              </p>
              <p className="text-lg font-medium">
                Collaboration without chaos.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Clients can
                </p>
                <StaggerContainer className="space-y-2">
                  {[
                    { icon: Eye, text: "See project progress and task status" },
                    {
                      icon: MessageSquare,
                      text: "Comment on tasks and deliverables",
                    },
                    { icon: Send, text: "Submit requests and feedback" },
                    {
                      icon: ThumbsUp,
                      text: "Approve work when it's ready",
                    },
                  ].map((item, i) => (
                    <StaggerItem key={i}>
                      <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
                        <item.icon className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-sm">{item.text}</span>
                      </div>
                    </StaggerItem>
                  ))}
                </StaggerContainer>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Clients don&apos;t
                </p>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border">
                  <EyeOff className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
                  <span className="text-sm text-muted-foreground">
                    Manage tasks, timelines, or workflow
                  </span>
                </div>
              </div>
            </div>
          </div>
        </BlurFade>
      </Section>

      {/* Automation */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Zap className="w-3.5 h-3.5" />
              Automation
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Smart, but restrained
            </h2>
            <p className="text-lg text-muted-foreground">
              Automation reduces busywork, improves consistency, and saves time.
              It never starts work, changes scope, or surprises anyone.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: EASING }}
            >
              <MagicCard
                className="p-6 h-full"
                gradientColor="#40ffaa20"
                gradientFrom="#40ffaa"
                gradientTo="#40ffaa80"
              >
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                  Automation does
                </h3>
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li>Suggest time entries from patterns</li>
                  <li>Generate invoices from tracked work</li>
                  <li>Notify when milestones are hit</li>
                  <li>Keep status pages current</li>
                </ul>
              </MagicCard>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: EASING }}
            >
              <MagicCard className="p-6 h-full" gradientSize={200}>
                <h3 className="font-semibold mb-4 flex items-center gap-2 text-muted-foreground">
                  <Shield className="w-5 h-5" />
                  Automation never
                </h3>
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li>Starts work on your behalf</li>
                  <li>Changes project scope or terms</li>
                  <li>Sends messages you didn&apos;t write</li>
                  <li>Makes decisions for you</li>
                </ul>
              </MagicCard>
            </motion.div>
          </div>

          <motion.p
            className="text-center text-lg font-medium mt-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.5 }}
          >
            Human judgment stays in control.
          </motion.p>
        </BlurFade>
      </Section>

      {/* Personal projects */}
      <Section size="small" width="wide">
        <BlurFade>
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 p-6 rounded-2xl bg-primary/5 border border-primary/10">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Briefcase className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">
                  Works for personal projects too
                </h3>
                <p className="text-sm text-muted-foreground">
                  Client collaboration is optional. The same structure works for
                  internal initiatives, solo work, and personal projects.
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground text-center md:text-right max-w-xs">
              Client-facing features layer on when needed.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Ready to work with intention?
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
