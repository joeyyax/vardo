"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BlurFade } from "@/components/ui/blur-fade";
import { MagicCard } from "@/components/ui/magic-card";
import { Section } from "@/components/marketing/section";
import { EASING } from "@/components/marketing/constants";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Briefcase,
  Check,
  CreditCard,
  Infinity,
  Sparkles,
} from "lucide-react";

function PricingCard({
  name,
  price,
  description,
  features,
  highlight = false,
  index = 0,
}: {
  name: string;
  price: string;
  description: string;
  features: string[];
  highlight?: boolean;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay: index * 0.1, ease: EASING }}
      whileHover={{ y: -5 }}
      className={cn(
        "relative rounded-2xl border p-8",
        highlight ? "bg-primary/5 border-primary" : "bg-card"
      )}
    >
      {highlight && (
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
          Most popular
        </div>
      )}
      <div className="mb-6">
        <h3 className="text-2xl font-bold mb-2">{name}</h3>
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-4xl font-bold">{price}</span>
          {price !== "Free" && (
            <span className="text-muted-foreground">/ month</span>
          )}
        </div>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <ul className="space-y-3 mb-8">
        {features.map((feature, i) => (
          <li key={i} className="flex items-start gap-3 text-sm">
            <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Button
        asChild
        className="w-full"
        variant={highlight ? "default" : "outline"}
      >
        <Link href="/login">Get started</Link>
      </Button>
    </motion.div>
  );
}

const FREE_ITEMS = [
  { label: "Projects", desc: "Create as many as you need" },
  { label: "Tasks", desc: "No limits, ever" },
  { label: "Time entries", desc: "Track everything" },
  { label: "Documents", desc: "Proposals, contracts, notes" },
  { label: "Invoices", desc: "Generate and send" },
  { label: "Exports & API", desc: "Your data, your way" },
];

export default function PricingContent() {
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
            <CreditCard className="w-4 h-4" />
            <span>Simple pricing</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: EASING }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6"
          >
            Predictable, fair,
            <br />
            <span className="text-muted-foreground">and calm.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: EASING }}
            className="text-xl sm:text-2xl text-muted-foreground max-w-2xl mx-auto"
          >
            Priced to support real work — not punish growth or complexity.
          </motion.p>
        </div>
      </section>

      {/* Pricing Cards */}
      <Section width="wide">
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <PricingCard
            name="Starter"
            price="Free"
            description="For getting set up and doing real work. No time limit."
            features={[
              "1 user",
              "Up to 3 external clients",
              "Unlimited internal work",
              "Unlimited projects",
              "Full feature access",
              "No credit card required",
            ]}
            index={0}
          />
          <PricingCard
            name="Solo"
            price="$12"
            description="For independent professionals doing active client work."
            features={[
              "1 user",
              "Unlimited external clients",
              "Time tracking & invoicing",
              "Projects, tasks & documents",
              "Proposals & contracts",
              "Client portal & reporting",
            ]}
            highlight
            index={1}
          />
          <PricingCard
            name="Team"
            price="$24"
            description="For small teams working together. One flat rate, regardless of size."
            features={[
              "Multiple users",
              "Unlimited external clients",
              "Task assignments & shared visibility",
              "Client collaboration",
              "Everything in Solo",
              "Flat rate — no per-seat pricing",
            ]}
            index={2}
          />
        </div>
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="text-sm text-center text-muted-foreground"
        >
          Internal work never counts against limits.
        </motion.p>
      </Section>

      {/* What you don't pay for */}
      <Section className="bg-secondary/30" size="large" width="wide">
        <BlurFade>
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Infinity className="w-3.5 h-3.5" />
              Always unlimited
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              What you never pay for
            </h2>
            <p className="text-lg text-muted-foreground">
              Usage-based pricing creates anxiety. These are free on every plan.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl mx-auto">
            {FREE_ITEMS.map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: EASING }}
              >
                <MagicCard className="p-5 h-full" gradientSize={120}>
                  <div className="flex items-start gap-3">
                    <Check className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-sm">{item.label}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                </MagicCard>
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </Section>

      {/* Internal work */}
      <Section size="large" width="wide">
        <BlurFade>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
                <Briefcase className="w-3.5 h-3.5" />
                Internal work
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
                Not all work is client work — and it still counts
              </h2>
              <p className="text-lg text-muted-foreground mb-6">
                Every organization includes an Internal client. Internal work is
                non-invoiced, fully tracked, included in reports, and always
                free. Understanding where your effort goes — not just what you
                bill — is how you make better decisions.
              </p>
              <p className="text-lg font-medium">
                All work is measured. Only some is billed.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  label: "Personal tools",
                  desc: "Side projects and internal tools",
                  gradient: "#40a8ff",
                },
                {
                  label: "Marketing",
                  desc: "Content, social, outreach",
                  gradient: "#9c40ff",
                },
                {
                  label: "Operations",
                  desc: "Admin, bookkeeping, planning",
                  gradient: "#ffaa40",
                },
                {
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

      {/* Philosophy */}
      <Section className="bg-secondary/30" size="large">
        <BlurFade>
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="w-3.5 h-3.5" />
              Philosophy
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-6">
              Scope costs less than the mental overhead it replaces
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              If you&apos;re thinking about the work instead of the bill,
              it&apos;s doing its job.
            </p>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto">
              Scope is independently built. No venture capital, no growth
              mandate. Pricing stays flat because there&apos;s no pressure to
              extract more from existing users. Features stay focused because
              they serve you — not investor milestones.
            </p>
          </div>
        </BlurFade>
      </Section>

      {/* CTA */}
      <Section className="text-center" size="large">
        <BlurFade>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Start building your workflow
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
