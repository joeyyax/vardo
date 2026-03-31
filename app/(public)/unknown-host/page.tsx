"use client";

import { useState } from "react";
import { AuroraText } from "@/components/ui/aurora-text";

export default function UnknownHostPage() {
  const [hovered, setHovered] = useState(false);
  const [clicked, setClicked] = useState(false);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <svg
          onClick={() => setClicked(true)}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 80 96"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-20 text-muted-foreground/30 animate-float"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <rect x="0" y="0" width="80" height="96" fill="transparent" stroke="none" style={{ pointerEvents: "all" }} />
        {/* Ghost body */}
        <path d="M16 40c0-13.3 10.7-24 24-24s24 10.7 24 24v40l-8-8-8 8-8-8-8 8-8-8-8 8V40Z" />
{/* Eyes */}
        <circle cx="33" cy="45" r="2.5" fill="currentColor" stroke="none" />
        <circle cx="47" cy="45" r="2.5" fill="currentColor" stroke="none" />
        {/* Mouth */}
        {/* Mouth */}
        <path
          d={hovered ? "M36 56q4 3 8 0" : "M36 56h8"}
          style={{ transition: "d 400ms ease-in-out" }}
        />
        </svg>
        <p className={`text-sm font-mono transition-opacity duration-300 ${clicked ? "opacity-100" : "opacity-0"}`}>
          <AuroraText speed={0.5} colors={["#ffffff", "#666666", "#999999", "#ffffff"]}>there&apos;s nothing here</AuroraText>
        </p>
      </div>
    </div>
  );
}
