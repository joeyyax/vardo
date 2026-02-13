"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { Section } from "@/components/marketing/section";
import { EASING } from "@/components/marketing/constants";
import {
  ArrowRight,
  BarChart3,
  Briefcase,
  CheckCircle2,
  HelpCircle,
  TrendingUp,
  XCircle,
} from "lucide-react";

const FAQ_ITEMS = [
  {
    question: "What is Internal work?",
    answer:
      "Internal work represents non-client work done by your business. This includes personal or internal projects, internal tools, marketing and content, operations and admin, and research and experimentation.",
  },
  {
    question: "Is Internal work free?",
    answer:
      "Yes. Every organization includes unlimited Internal work. It does not count toward client limits.",
  },
  {
    question: "Can I bill Internal work?",
    answer:
      "No. Internal work is non-invoiced by design. It is measured and reported, but never sent to a client.",
  },
  {
    question: "Does Internal work appear in reports?",
    answer:
      "Yes. Internal work appears in totals, affects trends, and contributes to utilization and cost. It is excluded only from client-facing views and invoices.",
  },
];

export default function InternalWorkContent() {
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
            <HelpCircle className="w-4 h-4" />
            <span>FAQ</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            Internal Work
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            Not all work is client work — and it still counts.
          </motion.p>
        </div>
      </section>

      {/* FAQ grid */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="grid sm:grid-cols-2 gap-4">
            {FAQ_ITEMS.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.1, ease: EASING }}
              >
                <MagicCard className="p-6 h-full" gradientSize={150}>
                  <h3 className="font-semibold mb-3">{item.question}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {item.answer}
                  </p>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Why track internal work */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <TrendingUp className="w-3.5 h-3.5" />
                Why it matters
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Why track Internal work at all?
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Because it&apos;s real work. Hiding internal effort leads to
                skewed profitability, poor planning, and burnout masked as
                efficiency.
              </p>
              <p className="text-lg font-medium">
                Scope tracks internal work honestly.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  icon: Briefcase,
                  label: "Personal tools",
                  desc: "Side projects and internal tools",
                  gradient: "#40a8ff",
                },
                {
                  icon: BarChart3,
                  label: "Marketing",
                  desc: "Content, social, outreach",
                  gradient: "#9c40ff",
                },
                {
                  icon: CheckCircle2,
                  label: "Operations",
                  desc: "Admin, bookkeeping, planning",
                  gradient: "#ffaa40",
                },
                {
                  icon: TrendingUp,
                  label: "Learning",
                  desc: "Research, experimentation, growth",
                  gradient: "#40ffaa",
                },
              ].map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1, ease: EASING }}
                >
                  <MagicCard
                    className="p-4 h-full"
                    gradientColor={`${item.gradient}20`}
                    gradientSize={100}
                    gradientFrom={item.gradient}
                    gradientTo={`${item.gradient}80`}
                  >
                    <item.icon className="w-5 h-5 text-primary mb-2" />
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

      {/* Measured vs billed */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <BarChart3 className="w-3.5 h-3.5" />
              Philosophy
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              All work is measured. Only some is billed.
            </h2>
            <p className="text-lg text-muted-foreground">
              Understanding where your effort goes — not just what you bill — is
              how you make better decisions.
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
                  Internal work includes
                </h3>
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li>Appears in time totals and trends</li>
                  <li>Contributes to utilization metrics</li>
                  <li>Visible in reports and breakdowns</li>
                  <li>Always free, always unlimited</li>
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
                  <XCircle className="w-5 h-5" />
                  Internal work excludes
                </h3>
                <ul className="space-y-3 text-sm text-muted-foreground">
                  <li>Never appears on invoices</li>
                  <li>Never visible to clients</li>
                  <li>Never counts against client limits</li>
                  <li>Never billed or charged</li>
                </ul>
              </MagicCard>
            </motion.div>
          </div>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Ready to track all your work?
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
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </BlurFade>
      </Section>
    </>
  );
}
