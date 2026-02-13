"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { BentoCard, BentoGrid } from "@/components/ui/bento-grid";
import { Section } from "@/components/marketing/section";
import { EASING } from "@/components/marketing/constants";
import {
  StaggerContainer,
  StaggerItem,
} from "@/components/marketing/animations";
import {
  ArrowRight,
  Ban,
  Briefcase,
  Check,
  Laptop,
  Palette,
  Scale,
  Shield,
  Sparkles,
  Star,
  Users,
  X,
} from "lucide-react";

const PERSONAS = [
  {
    name: "Freelancers",
    desc: "Solo professionals with direct client relationships who need to stay organized without overhead.",
    icon: Laptop,
    gradient: "#40a8ff",
  },
  {
    name: "Consultants",
    desc: "Advisory work with clear engagement boundaries, proposals, and structured billing.",
    icon: Briefcase,
    gradient: "#9c40ff",
  },
  {
    name: "Small studios",
    desc: "Small teams juggling multiple client projects who need shared visibility without chaos.",
    icon: Palette,
    gradient: "#ffaa40",
  },
  {
    name: "Boutique agencies",
    desc: "Focused teams that value quality over volume and need structure that scales with their work.",
    icon: Users,
    gradient: "#40ffaa",
  },
];

export default function ForYouContent() {
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
            <Users className="w-4 h-4" />
            <span>Who it&apos;s for</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            Built for people who
            <br />
            <span className="text-muted-foreground">
              already know how to work.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            You don&apos;t need more features. You need tools that respect your
            judgment.
          </motion.p>
        </div>
      </section>

      {/* Persona cards */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Scope is built for
            </h2>
            <p className="text-lg text-muted-foreground">
              People who do real client work and want better systems — not more
              configuration.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {PERSONAS.map((persona, i) => (
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
                  gradientColor={`${persona.gradient}20`}
                  gradientSize={200}
                  gradientFrom={persona.gradient}
                  gradientTo={`${persona.gradient}80`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <persona.icon className="w-5 h-5 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold">{persona.name}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {persona.desc}
                  </p>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Especially good if / Not for you — side by side */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-start">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Star className="w-3.5 h-3.5" />
                Great fit
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Especially good if you
              </h2>
              <StaggerContainer className="space-y-3">
                {[
                  "Are tired of duct-taping tools together",
                  "Want clients informed, not managing",
                  "Care about scope and clear intent",
                  "Prefer structure over endless configuration",
                  "Value clear boundaries in client relationships",
                  "Want billing to feel obvious, not reactive",
                ].map((item, i) => (
                  <StaggerItem key={i}>
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
                      <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                      <span className="text-sm">{item}</span>
                    </div>
                  </StaggerItem>
                ))}
              </StaggerContainer>
            </div>

            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-xs font-medium mb-4">
                <Ban className="w-3.5 h-3.5" />
                Honest about fit
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Probably not for you if you
              </h2>
              <StaggerContainer className="space-y-3">
                {[
                  "Need enterprise-level hierarchy and permissions",
                  "Want infinite workflow customization",
                  "Expect clients to manage tasks and priorities",
                  "Prefer tools that adapt to every edge case",
                ].map((item, i) => (
                  <StaggerItem key={i}>
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 border border-border">
                      <X className="w-5 h-5 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-muted-foreground">
                        {item}
                      </span>
                    </div>
                  </StaggerItem>
                ))}
              </StaggerContainer>

              <motion.p
                className="text-sm text-muted-foreground mt-6"
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.5 }}
              >
                That&apos;s okay. This product is opinionated by design.
              </motion.p>
            </div>
          </div>
        </BlurFade>
      </Section>

      {/* Why it matters — Bento */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Scale className="w-3.5 h-3.5" />
              Why it matters
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Clear constraints lead to better work
            </h2>
            <p className="text-lg text-muted-foreground">
              Scope optimizes for clarity, not coverage.
            </p>
          </div>

          <BentoGrid className="auto-rows-[minmax(140px,auto)] grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
            <BentoCard
              name="Better focus"
              className="lg:col-span-2"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Shield}
              description="Clear boundaries mean less time deciding what to work on and more time doing the work."
              href="/how-it-works"
              cta="See how it works"
            />
            <BentoCard
              name="Less friction"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Sparkles}
              description="Connected systems mean fewer handoffs and less context switching."
              href="/how-it-works"
              cta="Learn more"
            />
            <BentoCard
              name="More trust"
              className="lg:col-span-1"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Users}
              description="Visible progress and clear scope build client confidence naturally."
              href="/how-it-works"
              cta="Learn more"
            />
            <BentoCard
              name="Intentional, not reactive"
              className="lg:col-span-2"
              background={
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
              }
              Icon={Star}
              description="A system that reflects how work actually happens — reducing overhead instead of adding it."
              href="/pricing"
              cta="Get started"
            />
          </BentoGrid>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Sound like you?
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
