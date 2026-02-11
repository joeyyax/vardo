import { toPng } from "html-to-image";
import type { ScreenshotCapture } from "./types";

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Shows a full-page selection overlay. The user drags to select a region.
 * Returns the selected rectangle in page coordinates, or null if cancelled (Escape).
 */
export function selectArea(widgetHost: HTMLElement): Promise<SelectionRect | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "scope-selection-overlay";
    // Apply styles inline since this is outside the shadow DOM
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      cursor: "crosshair",
      background: "rgba(0, 0, 0, 0.15)",
    });

    // Instruction hint at top of screen
    const hint = document.createElement("div");
    Object.assign(hint.style, {
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#292524",
      color: "#fff",
      padding: "8px 16px",
      borderRadius: "10px",
      fontSize: "13px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      fontWeight: "500",
      pointerEvents: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
      whiteSpace: "nowrap",
      zIndex: "1",
    });
    hint.textContent = "Click and drag to select the problem area \u00b7 Esc to cancel";
    overlay.appendChild(hint);

    const rect = document.createElement("div");
    Object.assign(rect.style, {
      position: "absolute",
      border: "2px solid #b36b2d",
      background: "rgba(178, 107, 45, 0.08)",
      borderRadius: "4px",
      pointerEvents: "none",
      display: "none",
    });
    overlay.appendChild(rect);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    function cleanup() {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        cleanup();
        resolve(null);
      }
    }

    overlay.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      rect.style.display = "block";
      rect.style.left = `${startX}px`;
      rect.style.top = `${startY}px`;
      rect.style.width = "0px";
      rect.style.height = "0px";
    });

    overlay.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      rect.style.left = `${x}px`;
      rect.style.top = `${y}px`;
      rect.style.width = `${w}px`;
      rect.style.height = `${h}px`;
    });

    overlay.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      cleanup();

      // Require a minimum selection size
      if (w < 10 || h < 10) {
        resolve(null);
        return;
      }

      resolve({ x, y, width: w, height: h });
    });

    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(overlay);
  });
}

/**
 * Find the nearest scrolling ancestor by probing from the center of the viewport.
 * Returns the scroll container element, or null if window is the scroller.
 */
export function findScrollContainer(): HTMLElement | null {
  const probe = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  let el: HTMLElement | null = probe as HTMLElement | null;
  while (el && el !== document.body && el !== document.documentElement) {
    const { overflowY } = getComputedStyle(el);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null; // window is the scroller
}

/** Get the current scroll offset, accounting for inner scroll containers. */
export function getScrollOffset(): { x: number; y: number } {
  const container = findScrollContainer();
  if (container) {
    return { x: container.scrollLeft, y: container.scrollTop };
  }
  return { x: window.scrollX, y: window.scrollY };
}

const CONTEXT_PADDING = 200;

/**
 * Capture the full page and crop to an expanded area around the selection.
 * Draws a blue highlight around the selection and dims the surrounding context.
 */
export async function captureArea(
  selection: SelectionRect,
  widgetHost: HTMLElement
): Promise<ScreenshotCapture | null> {
  try {
    // Capture the full viewport
    const fullDataUrl = await toPng(document.body, {
      width: window.innerWidth,
      height: window.innerHeight,
      style: {
        transform: "none",
        transformOrigin: "top left",
      },
      filter: (node: HTMLElement) => {
        if (node === widgetHost) return false;
        if (node.classList?.contains("scope-selection-overlay")) return false;
        return true;
      },
    });

    const img = await loadImage(fullDataUrl);
    const dpr = window.devicePixelRatio || 1;

    // Compute expanded rect with padding, clamped to viewport
    const expandedRect = {
      x: Math.max(0, selection.x - CONTEXT_PADDING),
      y: Math.max(0, selection.y - CONTEXT_PADDING),
      width: 0,
      height: 0,
    };
    expandedRect.width =
      Math.min(window.innerWidth, selection.x + selection.width + CONTEXT_PADDING) - expandedRect.x;
    expandedRect.height =
      Math.min(window.innerHeight, selection.y + selection.height + CONTEXT_PADDING) - expandedRect.y;

    // Crop to expanded area
    const canvas = document.createElement("canvas");
    canvas.width = expandedRect.width * dpr;
    canvas.height = expandedRect.height * dpr;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.drawImage(
      img,
      expandedRect.x * dpr,
      expandedRect.y * dpr,
      expandedRect.width * dpr,
      expandedRect.height * dpr,
      0,
      0,
      expandedRect.width,
      expandedRect.height
    );

    // Selection position relative to the expanded crop
    const relX = selection.x - expandedRect.x;
    const relY = selection.y - expandedRect.y;

    // Dim area outside the selection (four strips)
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    // Top strip
    ctx.fillRect(0, 0, expandedRect.width, relY);
    // Bottom strip
    ctx.fillRect(0, relY + selection.height, expandedRect.width, expandedRect.height - relY - selection.height);
    // Left strip
    ctx.fillRect(0, relY, relX, selection.height);
    // Right strip
    ctx.fillRect(relX + selection.width, relY, expandedRect.width - relX - selection.width, selection.height);

    // Draw highlight border around selection
    ctx.strokeStyle = "#b36b2d";
    ctx.lineWidth = 2;
    ctx.strokeRect(relX, relY, selection.width, selection.height);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      selectionRect: { ...selection },
      expandedRect: { ...expandedRect },
      scrollOffset: getScrollOffset(),
    };
  } catch (err) {
    console.warn("[Scope] Screenshot capture failed:", err);
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Convert a data URL to a Blob for uploading */
export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)![1];
  const bytes = atob(parts[1]);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    arr[i] = bytes.charCodeAt(i);
  }
  return new Blob([arr], { type: mime });
}
