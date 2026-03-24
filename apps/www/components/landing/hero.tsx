"use client";

import Link from "next/link";
import { TerminalBlock } from "./terminal-block";
import { useState, useEffect } from "react";

const verbs = ["Deploy", "Launch", "Build", "Ship", "Stage", "Scale"];

function RotatingVerb() {
  const [text, setText] = useState(verbs[0]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const [showCursor, setShowCursor] = useState(true);

  // Blinking cursor
  useEffect(() => {
    const blink = setInterval(() => setShowCursor((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const currentWord = verbs[wordIndex];

    if (!isDeleting && text === currentWord) {
      const pause = setTimeout(() => setIsDeleting(true), 5000);
      return () => clearTimeout(pause);
    }

    if (isDeleting && text === "") {
      setIsDeleting(false);
      setWordIndex((i) => (i + 1) % verbs.length);
      return;
    }

    const speed = isDeleting ? 60 : 100;
    const timeout = setTimeout(() => {
      if (isDeleting) {
        setText(currentWord.slice(0, text.length - 1));
      } else {
        setText(currentWord.slice(0, text.length + 1));
      }
    }, speed);

    return () => clearTimeout(timeout);
  }, [text, isDeleting, wordIndex]);

  return (
    <span className="text-emerald-500">
      {text}
      <span
        className={`inline-block w-[0.04em] bg-emerald-500 ml-0.5 ${
          showCursor ? "opacity-100" : "opacity-0"
        }`}
        style={{ height: "0.8em", verticalAlign: "baseline", marginBottom: "-0.05em" }}
        aria-hidden="true"
      />
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
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm font-medium text-neutral-500">
              Install on any Ubuntu or Debian server in under five minutes
            </p>
            <TerminalBlock command="curl -fsSL https://vardo.run/install.sh | sudo bash" />
            <p className="mt-4 text-sm text-neutral-600">
              Not a fan of pipe-to-bash?{" "}
              <Link
                href="/docs/installation"
                className="text-neutral-400 underline underline-offset-2 decoration-neutral-700 hover:text-white transition-colors duration-150"
              >
                Install manually
              </Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
