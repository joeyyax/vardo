import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Term } from "@/components/term";
import { GLOSSARY } from "@/lib/ui/glossary";

const render = (passive: boolean) =>
  renderToStaticMarkup(createElement(Term, { id: "missing", passive } as Parameters<typeof Term>[0], "No container"));

function trigger(html: string): string {
  const m = html.match(/<(span|button)[^>]*data-term="missing"[^>]*>/);
  if (!m) throw new Error(`no trigger in ${html}`);
  return m[0];
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const escaped = (s: string) => s.replace(/'/g, "&#x27;");

describe("Term", () => {
  it("is a focusable button described by its glossary text", () => {
    const html = render(false);
    const tag = trigger(html);
    expect(tag.startsWith("<button")).toBe(true);
    expect(attr(tag, "type")).toBe("button");
    expect(attr(tag, "aria-haspopup")).toBe("dialog");
    expect(attr(tag, "aria-expanded")).toBe("false");
    const describedBy = attr(tag, "aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<span hidden="" id="${describedBy}">${escaped(GLOSSARY.missing.what)}</span>`);
    expect(html).toContain(">No container</button>");
  });

  it("adds no tab stop when passive", () => {
    const html = render(true);
    const tag = trigger(html);
    expect(tag.startsWith("<span")).toBe(true);
    expect(attr(tag, "tabindex")).toBeUndefined();
    const describedBy = attr(tag, "aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<span hidden="" id="${describedBy}">`);
  });
});
