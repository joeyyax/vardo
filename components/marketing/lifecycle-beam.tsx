"use client";

import { useRef, forwardRef } from "react";
import { motion } from "framer-motion";
import { AnimatedBeam } from "@/components/ui/animated-beam";
import { cn } from "@/lib/utils";
import {
  FileText,
  Handshake,
  Rocket,
  Briefcase,
  RotateCcw,
} from "lucide-react";
import { EASING } from "./constants";

const LifecycleNode = forwardRef<
  HTMLDivElement,
  { className?: string; children?: React.ReactNode; label: string; description: string }
>(({ className, children, label, description }, ref) => {
  return (
    <div className="flex flex-col items-center text-center">
      <div
        ref={ref}
        className={cn(
          "z-10 flex size-16 sm:size-20 items-center justify-center rounded-2xl bg-card border-2 border-primary/20 p-4 shadow-lg shadow-primary/5 transition-all duration-300 hover:border-primary hover:shadow-primary/20 hover:scale-105",
          className
        )}
      >
        {children}
      </div>
      <div className="mt-4">
        <span className="block text-sm sm:text-base font-semibold">{label}</span>
        <span className="block text-xs sm:text-sm text-muted-foreground mt-1 max-w-[120px]">
          {description}
        </span>
      </div>
    </div>
  );
});
LifecycleNode.displayName = "LifecycleNode";

/** Animated beam lifecycle visualization showing the 5-stage work flow. */
export function LifecycleBeam() {
  const containerRef = useRef<HTMLDivElement>(null);
  const proposalRef = useRef<HTMLDivElement>(null);
  const agreementRef = useRef<HTMLDivElement>(null);
  const onboardingRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const ongoingRef = useRef<HTMLDivElement>(null);

  const steps = [
    { ref: proposalRef, icon: FileText, label: "Proposal", description: "Define scope & terms", gradient: "#ffaa40" },
    { ref: agreementRef, icon: Handshake, label: "Agreement", description: "Clear acceptance", gradient: "#ff6b40" },
    { ref: onboardingRef, icon: Rocket, label: "Onboarding", description: "Set expectations", gradient: "#9c40ff" },
    { ref: activeRef, icon: Briefcase, label: "Active work", description: "Execute with clarity", gradient: "#40a8ff" },
    { ref: ongoingRef, icon: RotateCcw, label: "Ongoing", description: "Maintain or close", gradient: "#40ffaa" },
  ];

  return (
    <div
      className="relative flex w-full max-w-4xl mx-auto items-center justify-center overflow-hidden py-8 sm:py-12"
      ref={containerRef}
    >
      <div className="flex w-full flex-row items-center justify-between px-2">
        {steps.map((step, index) => (
          <motion.div
            key={step.label}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: index * 0.1, ease: EASING }}
          >
            <LifecycleNode
              ref={step.ref}
              label={step.label}
              description={step.description}
              className="relative"
            >
              <step.icon className="w-6 h-6 sm:w-8 sm:h-8 text-primary" />
              {/* Pulse effect */}
              <motion.div
                className="absolute inset-0 rounded-2xl border-2 border-primary/40"
                initial={{ scale: 1, opacity: 0 }}
                animate={{ scale: 1.4, opacity: [0, 0.4, 0] }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  delay: index * 0.3,
                  ease: "easeInOut",
                }}
              />
            </LifecycleNode>
          </motion.div>
        ))}
      </div>

      {/* Animated beams connecting the nodes */}
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={proposalRef}
        toRef={agreementRef}
        curvature={15}
        gradientStartColor="#ffaa40"
        gradientStopColor="#ff6b40"
        duration={3}
        delay={0}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={agreementRef}
        toRef={onboardingRef}
        curvature={-15}
        gradientStartColor="#ff6b40"
        gradientStopColor="#9c40ff"
        duration={3}
        delay={0.2}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={onboardingRef}
        toRef={activeRef}
        curvature={15}
        gradientStartColor="#9c40ff"
        gradientStopColor="#40a8ff"
        duration={3}
        delay={0.4}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={activeRef}
        toRef={ongoingRef}
        curvature={-15}
        gradientStartColor="#40a8ff"
        gradientStopColor="#40ffaa"
        duration={3}
        delay={0.6}
      />
    </div>
  );
}
