"use client";

import Link from "next/link";
import { TerminalBlock } from "./terminal-block";
import { useState, useEffect } from "react";

const words = [
  { text: "Deploy", color: "text-emerald-400" },
  { text: "Launch", color: "text-sky-400" },
  { text: "Build", color: "text-amber-400" },
  { text: "Ship", color: "text-violet-400" },
  { text: "Stage", color: "text-rose-400" },
  { text: "Scale", color: "text-teal-400" },
];

function RotatingVerb() {
  const [text, setText] = useState(words[0].text);
  const [isDeleting, setIsDeleting] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const [showCursor, setShowCursor] = useState(true);

  const currentColor = words[wordIndex].color;

  useEffect(() => {
    const blink = setInterval(() => setShowCursor((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const currentWord = words[wordIndex].text;

    if (!isDeleting && text === currentWord) {
      const pause = setTimeout(() => setIsDeleting(true), 5000);
      return () => clearTimeout(pause);
    }

    if (isDeleting && text === "") {
      setIsDeleting(false);
      setWordIndex((i) => (i + 1) % words.length);
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
    <span className={`transition-colors duration-300 ${currentColor}`}>
      {text}
      <span
        className={`inline-block w-[0.04em] ml-0.5 transition-colors duration-300 ${
          currentColor.replace("text-", "bg-")
        } ${showCursor ? "opacity-100" : "opacity-0"}`}
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
            <RotatingVerb />{" "}
            <span className="text-neutral-300">on your terms.</span>
          </h1>
          <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-neutral-400 sm:text-xl">
            Vardo is a self-hosted platform for deploying Docker apps.
            Push your code, get HTTPS, backups, and monitoring —{" "}
            <span className="font-mono text-base text-neutral-300">
              without learning Kubernetes
            </span>{" "}
            or paying for PaaS.
          </p>
          <div className="mx-auto mt-14 max-w-xl">
            <p className="mb-3 text-sm text-neutral-500 font-mono tracking-wide">
              ~ one command, five minutes
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
