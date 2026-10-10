"use client";

import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { useRouter } from "next/navigation";

/** Makes `el` the list's one tabbable row and moves focus to it. */
export function focusRow(list: HTMLElement | null, el: HTMLElement | null | undefined) {
  if (!list || !el) return;
  list.querySelectorAll<HTMLElement>("[data-nav]").forEach((n) => (n.tabIndex = -1));
  el.tabIndex = 0;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
}

/** Focuses the row with this nav key, if it is still in the list. */
export function focusRowByKey(list: HTMLElement | null, key: string) {
  focusRow(list, list?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(key)}"]`));
}

/**
 * Keyboard for a list of `[data-nav]` rows: arrows or j/k move, Enter, Space or o opens,
 * right and left unfold and fold, Shift+Enter follows the row's link. One row is tabbable.
 */
export function useRowKeys(list: RefObject<HTMLElement | null>) {
  const router = useRouter();

  useEffect(() => {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-nav]");
    if (rows?.length && ![...rows].some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
  });

  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const root = list.current;
    if (!root) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-nav]")];
    const target = e.target as HTMLElement;
    const current = target.closest<HTMLElement>("[data-nav]");
    if (!current) return;
    const i = rows.indexOf(current);
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (down || up) {
      e.preventDefault();
      return focusRow(root, rows[down ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]);
    }
    // Keys below belong to the row, not a control inside it.
    if (target !== current) return;
    const expanded = current.getAttribute("aria-expanded");
    if ((e.key === "ArrowRight" || e.key === "l") && expanded === "false") {
      e.preventDefault();
      return current.click();
    }
    if ((e.key === "ArrowLeft" || e.key === "h") && expanded === "true") {
      e.preventDefault();
      return current.click();
    }
    if (e.key === "Enter" && e.shiftKey) {
      const link = current.querySelector<HTMLAnchorElement>("a[data-row-link]");
      if (!link) return;
      e.preventDefault();
      return router.push(link.getAttribute("href")!);
    }
    if (e.key === "Enter" || e.key === " " || e.key === "o") {
      e.preventDefault();
      current.click();
    }
  };
}
