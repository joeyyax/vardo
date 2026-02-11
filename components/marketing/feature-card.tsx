"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { EASING } from "./constants";

export function FeatureCard({
  icon: Icon,
  title,
  description,
  image,
  index = 0,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  image: string;
  index?: number;
}) {
  return (
    <motion.div
      className="group relative bg-card rounded-2xl border overflow-hidden"
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, delay: index * 0.15, ease: EASING }}
      whileHover={{
        y: -8,
        boxShadow: "0 25px 50px -12px rgba(0,0,0,0.15)",
      }}
    >
      <div className="aspect-[16/10] relative overflow-hidden">
        <motion.div
          className="absolute inset-0"
          whileHover={{ scale: 1.08 }}
          transition={{ duration: 0.6 }}
        >
          <Image
            src={image}
            alt={title}
            fill
            className="object-cover"
          />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
        {/* Hover overlay */}
        <motion.div
          className="absolute inset-0 bg-primary/5"
          initial={{ opacity: 0 }}
          whileHover={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        />
      </div>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-3">
          <motion.div
            className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center"
            whileHover={{ rotate: 10, scale: 1.1 }}
            transition={{ type: "spring", stiffness: 300 }}
          >
            <Icon className="w-5 h-5 text-primary" />
          </motion.div>
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
        <p className="text-muted-foreground leading-relaxed">{description}</p>
      </div>

      {/* Corner decoration */}
      <motion.div
        className="absolute top-4 right-4 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center"
        initial={{ scale: 0, rotate: -45 }}
        whileHover={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 300 }}
      >
        <ArrowUpRight className="w-4 h-4 text-primary" />
      </motion.div>
    </motion.div>
  );
}
