"use client";

import Link from "next/link";
import { TerminalBlock } from "./terminal-block";
import { useState, useEffect } from "react";

const verbs = ["Deploy", "Launch", "Build", "Ship", "Stage", "Scale"];

function RotatingVerb() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % verbs.length);
        setVisible(true);
      }, 300);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Measure the widest verb to prevent layout shift
  return (
    <span className="relative inline-block text-blue-500">
      {/* Invisible widest verb holds the space */}
      <span className="invisible" aria-hidden="true">
        {verbs.reduce((a, b) => (a.length >= b.length ? a : b))}
      </span>
      {/* Visible verb positioned on top */}
      <span
        className={`absolute inset-0 transition-all duration-300 ease-out ${
          visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
        }`}
      >
        {verbs[index]}
      </span>
    </span>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto flex min-h-[90vh] items-center justify-center px-4 sm:px-6 lg:px-8">
        <div className="w-full text-center">
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl xl:text-8xl">
            <RotatingVerb /> on your terms.
          </h1>
          <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-neutral-300 sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps. Push
            your code, get HTTPS, backups, and monitoring — without learning
            Kubernetes or paying for PaaS.
          </p>
          <div className="mt-10">
            <Link
              href="/docs/getting-started"
              className="inline-flex h-12 items-center rounded-xl bg-blue-500 px-8 text-sm font-semibold text-white transition-all duration-200 hover:bg-blue-600 hover:-translate-y-0.5"
            >
              Get Started
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm font-medium text-neutral-500">
              Install on any Ubuntu or Debian server in under five minutes
            </p>
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
          </div>
        </div>
      </div>
    </section>
  );
}
