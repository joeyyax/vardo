import { registerModule } from "../registry";
import { selectArea, captureArea, findScrollContainer, getScrollOffset } from "../screenshot";
import { collectMetadata } from "../metadata";
import type {
  WidgetModule,
  ModuleContext,
  AuthResponse,
  BugReport,
  ScreenshotCapture,
  SubmitPayload,
} from "../types";

// SVG icon helpers using DOM APIs (no innerHTML)
function createSvgElement(
  tag: string,
  attrs: Record<string, string>
): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function createCloseIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(
    createSvgElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" })
  );
  svg.appendChild(
    createSvgElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
  );
  return svg;
}

function createEyeIcon(visible: boolean): SVGElement {
  const svg = createSvgElement("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });

  if (visible) {
    svg.appendChild(createSvgElement("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }));
    svg.appendChild(createSvgElement("circle", { cx: "12", cy: "12", r: "3" }));
  } else {
    svg.appendChild(createSvgElement("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }));
    svg.appendChild(createSvgElement("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }));
    svg.appendChild(createSvgElement("line", { x1: "1", y1: "1", x2: "23", y2: "23" }));
  }
  return svg;
}

function createCheckIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(createSvgElement("polyline", { points: "20 6 9 17 4 12" }));
  return svg;
}

function createGlobeIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(createSvgElement("circle", { cx: "12", cy: "12", r: "10" }));
  svg.appendChild(createSvgElement("line", { x1: "2", y1: "12", x2: "22", y2: "12" }));
  svg.appendChild(createSvgElement("path", { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }));
  return svg;
}

function createCommentIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(createSvgElement("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }));
  return svg;
}

function createInboxIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.appendChild(createSvgElement("polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }));
  svg.appendChild(createSvgElement("path", { d: "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }));
  return svg;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function formatSmartDate(report: { createdAt: string; updatedAt?: string }): string {
  const created = report.createdAt;
  const updated = report.updatedAt;
  if (updated && updated !== created) {
    // Check if dates differ (ignoring exact ms)
    const c = new Date(created).getTime();
    const u = new Date(updated).getTime();
    if (Math.abs(u - c) > 60_000) {
      return `Updated ${formatDate(updated)}`;
    }
  }
  return formatDate(created);
}

const PRIORITY_COLORS: Record<string, string> = {
  low: "#94a3b8",     // slate-400
  medium: "#3b82f6",  // blue-500
  high: "#f97316",    // orange-500
  urgent: "#ef4444",  // red-500
};

/** Build a branded text span: [scope] with faded brackets */
function createBrandedMark(
  className: string,
  bracketClass: string
): HTMLElement {
  const mark = document.createElement("span");
  mark.className = className;

  const open = document.createElement("span");
  open.className = bracketClass;
  open.textContent = "[";

  const text = document.createTextNode("scope");

  const close = document.createElement("span");
  close.className = bracketClass;
  close.textContent = "]";

  mark.appendChild(open);
  mark.appendChild(text);
  mark.appendChild(close);
  return mark;
}

/** Create the branded [s] trigger mark */
function createTriggerMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "scope-trigger-mark";

  const open = document.createElement("span");
  open.className = "scope-bracket";
  open.textContent = "[";

  const letter = document.createElement("span");
  letter.textContent = "s";

  const close = document.createElement("span");
  close.className = "scope-bracket";
  close.textContent = "]";

  mark.appendChild(open);
  mark.appendChild(letter);
  mark.appendChild(close);
  return mark;
}

/** Create panel header with title and close button */
function createPanelHeader(
  viewLabel: string,
  onClose: () => void
): HTMLElement {
  const header = document.createElement("div");
  header.className = "scope-panel-header";

  const title = document.createElement("span");
  title.className = "scope-header-title";
  title.textContent = viewLabel;
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.appendChild(createCloseIcon());
  closeBtn.addEventListener("click", onClose);
  header.appendChild(closeBtn);

  return header;
}

/** Create footer with scope logo, status indicator, and visibility note */
function createPanelFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "scope-panel-footer";

  footer.appendChild(
    createBrandedMark("scope-footer-mark", "scope-footer-bracket")
  );

  const dot = document.createElement("span");
  dot.className = "scope-footer-dot";
  footer.appendChild(dot);

  const status = document.createElement("span");
  status.className = "scope-footer-status";
  status.textContent = "Hidden from public";
  footer.appendChild(status);

  return footer;
}

class BugReportModule implements WidgetModule {
  id = "bug-report";
  private ctx!: ModuleContext;
  private auth!: AuthResponse;
  private reports: BugReport[] = [];
  private screenshots: ScreenshotCapture[] = [];
  private panelOpen = false;
  private view: "list" | "form" | "success" = "list";
  private overlayElements: Map<string, HTMLElement> = new Map();
  private overlayDocCoords: Map<string, { x: number; y: number; w: number; h: number }> = new Map();
  private overlayVisibility: Map<string, boolean> = new Map();
  private selectedPriority: string | null = null;
  private scrollHandler: (() => void) | null = null;
  private scrollTarget: HTMLElement | Window | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  init(ctx: ModuleContext) {
    this.ctx = ctx;
    this.auth = ctx.auth;
    this.reports = (ctx.auth.reports || []) as BugReport[];
    this.renderTrigger();
    this.listenForEscape();
  }

  destroy() {
    this.clearPageOverlays();
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
    }
  }

  private get shadow() {
    return this.ctx.shadow;
  }

  private renderTrigger() {
    this.clearPanel();

    const btn = document.createElement("button");
    btn.className = "scope-trigger";
    btn.title = "Report an issue";
    btn.appendChild(createTriggerMark());
    btn.addEventListener("click", () => this.togglePanel());
    this.shadow.appendChild(btn);
  }

  private togglePanel() {
    if (this.panelOpen) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  private openPanel() {
    this.panelOpen = true;
    this.view = "list";
    this.screenshots = [];
    this.renderPanel();
    this.renderPageOverlays();
  }

  private closePanel() {
    this.panelOpen = false;
    this.screenshots = [];
    this.clearPageOverlays();
    this.clearPanel();
  }

  private hidePanel() {
    this.panelOpen = false;
    this.clearPageOverlays();
    this.clearPanel();
  }

  private clearPanel() {
    const panel = this.shadow.querySelector(".scope-panel");
    if (panel) panel.remove();
  }

  private renderPanel() {
    this.clearPanel();

    const panel = document.createElement("div");
    panel.className = "scope-panel";

    // Branded header
    const viewLabel =
      this.view === "form" ? "Report an Issue" : "Feedback";
    panel.appendChild(
      createPanelHeader(viewLabel, () => this.closePanel())
    );

    // Body
    const body = document.createElement("div");
    body.className = "scope-panel-body";

    if (this.view === "list") {
      this.renderReportList(body);
    } else if (this.view === "form") {
      this.renderForm(body);
    } else if (this.view === "success") {
      this.renderSuccess(body);
    }

    panel.appendChild(body);

    // Footer
    panel.appendChild(createPanelFooter());

    this.shadow.appendChild(panel);
  }

  private renderReportList(container: HTMLElement) {
    const intro = document.createElement("div");
    intro.className = "scope-intro";
    intro.textContent =
      "Spotted something off? Capture the problem area, add a description, and we'll take care of it.";
    container.appendChild(intro);

    const btn = document.createElement("button");
    btn.className = "scope-btn scope-btn-primary";
    btn.style.width = "100%";
    btn.style.marginBottom = "16px";
    btn.textContent = "Report an Issue";
    btn.addEventListener("click", () => this.startCapture());
    container.appendChild(btn);

    const label = document.createElement("div");
    label.className = "scope-section-label";
    label.textContent = "Previous Reports";
    container.appendChild(label);

    if (this.reports.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scope-empty";

      const iconWrap = document.createElement("div");
      iconWrap.className = "scope-empty-icon";
      iconWrap.appendChild(createInboxIcon());
      empty.appendChild(iconWrap);

      const text = document.createElement("div");
      text.textContent = "No reports yet";
      empty.appendChild(text);

      container.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "scope-report-list";

      const currentUrl = window.location.href;
      const sorted = [...this.reports].sort((a, b) => {
        const aMatch = a.pageUrl === currentUrl ? 0 : 1;
        const bMatch = b.pageUrl === currentUrl ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      for (const report of sorted) {
        const item = document.createElement("li");
        item.className = "scope-report-item";
        item.addEventListener("click", () => {
          window.open(
            `${this.ctx.config.apiUrl}/projects/${this.auth.defaultProjectId}`,
            "_blank"
          );
        });

        // Top row: [priority dot] description [eye toggle]
        const topRow = document.createElement("div");
        topRow.style.display = "flex";
        topRow.style.alignItems = "center";
        topRow.style.gap = "6px";

        if (report.priority && PRIORITY_COLORS[report.priority]) {
          const dot = document.createElement("span");
          dot.className = `scope-priority-dot scope-priority-${report.priority}`;
          topRow.appendChild(dot);
        }

        const desc = document.createElement("div");
        desc.className = "scope-report-item-desc";
        desc.style.flex = "1";
        desc.textContent = report.description;
        topRow.appendChild(desc);

        const isCurrentPage = report.pageUrl === currentUrl;
        const hasSelectionData = !!(report.metadata?.screenshots as unknown[])?.length;
        if (isCurrentPage && hasSelectionData) {
          const eyeBtn = document.createElement("button");
          eyeBtn.className = "scope-overlay-toggle";
          const visible = this.overlayVisibility.get(report.id) !== false;
          eyeBtn.appendChild(createEyeIcon(visible));
          eyeBtn.title = visible ? "Hide overlay" : "Show overlay";
          eyeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleOverlay(report.id);
          });
          topRow.appendChild(eyeBtn);
        }

        item.appendChild(topRow);

        // Meta row: [status] [page badge] [comments] [assignee] [date]
        const meta = document.createElement("div");
        meta.className = "scope-report-item-meta";

        const status = document.createElement("span");
        status.className = `scope-report-status scope-status-${report.status}`;
        status.textContent = report.status;
        meta.appendChild(status);

        const pageBadge = document.createElement("span");
        if (isCurrentPage) {
          pageBadge.className = "scope-report-page-badge scope-page-badge-current";
          pageBadge.textContent = "This page";
        } else if (report.pageUrl) {
          pageBadge.className = "scope-report-page-badge scope-page-badge-other";
          try {
            const url = new URL(report.pageUrl);
            pageBadge.textContent = url.pathname.length > 20
              ? url.pathname.slice(0, 18) + "\u2026"
              : url.pathname;
          } catch {
            pageBadge.textContent = "Other page";
          }
        }
        if (pageBadge.textContent) meta.appendChild(pageBadge);

        // Comment count
        if (report.commentCount && report.commentCount > 0) {
          const commentWrap = document.createElement("span");
          commentWrap.className = "scope-comment-count";
          commentWrap.appendChild(createCommentIcon());
          const countText = document.createTextNode(String(report.commentCount));
          commentWrap.appendChild(countText);
          meta.appendChild(commentWrap);
        }

        // Assignee avatar
        if (report.assignee) {
          const avatar = document.createElement("span");
          avatar.className = "scope-assignee-avatar";
          avatar.textContent = (report.assignee.name || report.assignee.email || "?").charAt(0).toUpperCase();
          avatar.title = report.assignee.name || report.assignee.email;
          meta.appendChild(avatar);
        }

        const date = document.createElement("span");
        date.textContent = formatSmartDate(report);
        meta.appendChild(date);

        item.appendChild(meta);
        list.appendChild(item);
      }

      container.appendChild(list);
    }
  }

  private async startCapture() {
    this.hidePanel();

    const selection = await selectArea(this.ctx.host);
    if (!selection) {
      this.panelOpen = true;
      this.view = this.screenshots.length > 0 ? "form" : "list";
      this.renderPanel();
      if (this.view === "list") this.renderPageOverlays();
      return;
    }

    const capture = await captureArea(selection, this.ctx.host);
    if (capture) {
      this.screenshots.push(capture);
    }

    this.view = "form";
    this.panelOpen = true;
    this.renderPanel();
  }

  private renderForm(container: HTMLElement) {
    // Page URL context
    const pageContext = document.createElement("div");
    pageContext.className = "scope-page-context";
    pageContext.appendChild(createGlobeIcon());
    const pageSpan = document.createElement("span");
    try {
      const url = new URL(window.location.href);
      pageSpan.textContent = url.host + url.pathname;
    } catch {
      pageSpan.textContent = window.location.href;
    }
    pageContext.appendChild(pageSpan);
    container.appendChild(pageContext);

    // Screenshot gallery / add button
    if (this.screenshots.length > 0) {
      const gallery = document.createElement("div");
      gallery.className = "scope-screenshot-gallery";

      for (let i = 0; i < this.screenshots.length; i++) {
        const thumb = document.createElement("div");
        thumb.className = "scope-screenshot-thumb";

        const img = document.createElement("img");
        img.src = this.screenshots[i].dataUrl;
        img.alt = `Screenshot ${i + 1}`;
        thumb.appendChild(img);

        const removeBtn = document.createElement("button");
        removeBtn.className = "scope-screenshot-remove";
        removeBtn.textContent = "\u00d7";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", () => {
          this.screenshots.splice(i, 1);
          this.renderPanel();
        });
        thumb.appendChild(removeBtn);

        gallery.appendChild(thumb);
      }

      container.appendChild(gallery);

      const addBtn = document.createElement("button");
      addBtn.className = "scope-screenshot-add";
      addBtn.textContent = "+ Add Another Screenshot";
      addBtn.addEventListener("click", () => this.startCapture());
      container.appendChild(addBtn);
    } else {
      const captureBtn = document.createElement("button");
      captureBtn.className = "scope-new-report-btn";
      captureBtn.textContent = "+ Add Screenshot";
      captureBtn.style.marginTop = "0";
      captureBtn.style.marginBottom = "12px";
      captureBtn.addEventListener("click", () => this.startCapture());
      container.appendChild(captureBtn);
    }

    // Form fields container
    const fields = document.createElement("div");
    fields.className = "scope-form-fields";

    // Severity selector
    const severityLabel = document.createElement("label");
    severityLabel.className = "scope-field-label";
    severityLabel.textContent = "Severity";
    fields.appendChild(severityLabel);

    const severityRow = document.createElement("div");
    severityRow.className = "scope-severity-selector";

    const priorities = [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "urgent", label: "Urgent" },
    ] as const;

    for (const p of priorities) {
      const btn = document.createElement("button");
      btn.className = `scope-severity-btn${this.selectedPriority === p.value ? " scope-severity-selected" : ""}`;
      btn.type = "button";
      btn.setAttribute("data-priority", p.value);

      const dot = document.createElement("span");
      dot.className = `scope-severity-dot scope-severity-${p.value}`;
      btn.appendChild(dot);

      const text = document.createTextNode(p.label);
      btn.appendChild(text);

      btn.addEventListener("click", () => {
        // Toggle off if already selected
        this.selectedPriority = this.selectedPriority === p.value ? null : p.value;
        // Update button states in-place instead of re-rendering
        const buttons = severityRow.querySelectorAll(".scope-severity-btn");
        buttons.forEach((b) => {
          const val = b.getAttribute("data-priority");
          if (val === this.selectedPriority) {
            b.classList.add("scope-severity-selected");
          } else {
            b.classList.remove("scope-severity-selected");
          }
        });
      });

      severityRow.appendChild(btn);
    }
    fields.appendChild(severityRow);

    // "What happened?" textarea (required)
    const whatLabel = document.createElement("label");
    whatLabel.className = "scope-field-label";
    whatLabel.textContent = "What happened?";
    fields.appendChild(whatLabel);

    const whatTextarea = document.createElement("textarea");
    whatTextarea.className = "scope-textarea";
    whatTextarea.placeholder = "Describe what went wrong...";
    whatTextarea.setAttribute("rows", "2");
    fields.appendChild(whatTextarea);

    // "What did you expect?" textarea (optional)
    const expectLabel = document.createElement("label");
    expectLabel.className = "scope-field-label";
    expectLabel.textContent = "What did you expect?";
    fields.appendChild(expectLabel);

    const expectTextarea = document.createElement("textarea");
    expectTextarea.className = "scope-textarea";
    expectTextarea.placeholder = "What should have happened instead?";
    expectTextarea.setAttribute("rows", "2");
    fields.appendChild(expectTextarea);

    container.appendChild(fields);

    // Form actions
    const formActions = document.createElement("div");
    formActions.className = "scope-form-actions";

    const backBtn = document.createElement("button");
    backBtn.className = "scope-btn scope-btn-secondary";
    backBtn.textContent = "Back";
    backBtn.addEventListener("click", () => {
      this.view = "list";
      this.screenshots = [];
      this.selectedPriority = null;
      this.renderPanel();
      this.renderPageOverlays();
    });
    formActions.appendChild(backBtn);

    const submitBtn = document.createElement("button");
    submitBtn.className = "scope-btn scope-btn-primary";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", () => {
      const what = whatTextarea.value.trim();
      const expect = expectTextarea.value.trim();
      let description = "";
      if (what && expect) {
        description = `What happened:\n${what}\n\nExpected behavior:\n${expect}`;
      } else if (what) {
        description = what;
      }
      this.handleSubmit(description, submitBtn);
    });
    formActions.appendChild(submitBtn);

    container.appendChild(formActions);

    requestAnimationFrame(() => whatTextarea.focus());
  }

  private async handleSubmit(description: string, btn: HTMLButtonElement) {
    if (!description.trim()) {
      const textarea = this.shadow.querySelector(
        ".scope-textarea"
      ) as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.borderColor = "#ef4444";
        setTimeout(() => (textarea.style.borderColor = ""), 1500);
      }
      return;
    }

    btn.disabled = true;
    const spinner = document.createElement("span");
    spinner.className = "scope-spinner";
    btn.textContent = "";
    btn.appendChild(spinner);

    const metadata = collectMetadata(this.ctx.config.env);
    const payload: SubmitPayload = {
      organizationId: this.auth.organizationId!,
      projectId: this.auth.defaultProjectId!,
      clientId: this.auth.clientId!,
      scopeClientId: this.auth.scopeClientId!,
      description: description.trim(),
      pageUrl: window.location.href,
      priority: this.selectedPriority,
      metadata,
      screenshots: this.screenshots,
    };

    const result = await this.ctx.bridge.submitReport(payload);

    if (!result.success) {
      this.renderFeedback("error", result.error || "Something went wrong");
      btn.disabled = false;
      btn.textContent = "Submit";
      return;
    }

    if (result.report) {
      this.reports.unshift(result.report);
    }

    this.view = "success";
    this.screenshots = [];
    this.selectedPriority = null;
    this.renderPanel();
  }

  private renderSuccess(container: HTMLElement) {
    const content = document.createElement("div");
    content.className = "scope-success-content";

    const iconWrap = document.createElement("div");
    iconWrap.className = "scope-success-icon";
    iconWrap.appendChild(createCheckIcon());
    content.appendChild(iconWrap);

    const title = document.createElement("div");
    title.className = "scope-success-title";
    title.textContent = "Report submitted";
    content.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "scope-success-desc";
    desc.textContent = "We'll look into this and follow up.";
    content.appendChild(desc);

    const backBtn = document.createElement("button");
    backBtn.className = "scope-btn scope-btn-secondary";
    backBtn.textContent = "Back to Reports";
    backBtn.style.width = "100%";
    backBtn.addEventListener("click", () => {
      this.view = "list";
      this.renderPanel();
      this.renderPageOverlays();
    });
    content.appendChild(backBtn);

    container.appendChild(content);
  }

  private renderFeedback(type: "success" | "error", message: string) {
    const body = this.shadow.querySelector(".scope-panel-body");
    if (!body) return;

    const existing = body.querySelector(".scope-feedback");
    if (existing) existing.remove();

    const fb = document.createElement("div");
    fb.className = `scope-feedback scope-feedback-${type}`;
    fb.textContent = message;
    body.insertBefore(fb, body.firstChild);

    if (type === "error") {
      setTimeout(() => fb.remove(), 4000);
    }
  }

  // --- Page overlays for current-page reports ---

  private renderPageOverlays() {
    this.clearPageOverlays();

    const currentUrl = window.location.href;
    const container = findScrollContainer();
    const scroll = getScrollOffset();

    for (const report of this.reports) {
      if (report.pageUrl !== currentUrl) continue;
      const screenshots = report.metadata?.screenshots as
        | Array<{
            selectionRect?: { x: number; y: number; width: number; height: number };
            scrollOffset?: { x: number; y: number };
          }>
        | undefined;
      if (!screenshots?.length) continue;

      if (!this.overlayVisibility.has(report.id)) {
        this.overlayVisibility.set(report.id, true);
      }
      if (!this.overlayVisibility.get(report.id)) continue;

      for (const ss of screenshots) {
        if (!ss.selectionRect) continue;
        const { x, y, width, height } = ss.selectionRect;
        const docX = x + (ss.scrollOffset?.x ?? 0);
        const docY = y + (ss.scrollOffset?.y ?? 0);

        const el = document.createElement("div");
        el.setAttribute("data-scope-overlay", report.id);
        Object.assign(el.style, {
          position: "fixed",
          width: `${width}px`,
          height: `${height}px`,
          border: "2px solid #b36b2d",
          background: "rgba(178, 107, 45, 0.08)",
          borderRadius: "4px",
          pointerEvents: "none",
          zIndex: "2147483640",
        });

        const label = document.createElement("div");
        Object.assign(label.style, {
          position: "absolute",
          bottom: "-22px",
          left: "0",
          background: "#b36b2d",
          color: "#fff",
          fontSize: "10px",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          fontWeight: "600",
          padding: "2px 6px",
          borderRadius: "3px",
          whiteSpace: "nowrap",
          maxWidth: "200px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        });
        label.textContent = report.description.length > 30
          ? report.description.slice(0, 28) + "\u2026"
          : report.description;
        el.appendChild(label);

        document.body.appendChild(el);
        const key = `${report.id}-${docX}-${docY}`;
        this.overlayElements.set(key, el);
        this.overlayDocCoords.set(key, { x: docX, y: docY, w: width, h: height });
      }
    }

    this.updateOverlayPositions(scroll);
    if (this.overlayElements.size > 0 && !this.scrollHandler) {
      this.scrollTarget = container || window;
      this.scrollHandler = () => this.updateOverlayPositions(getScrollOffset());
      this.scrollTarget.addEventListener("scroll", this.scrollHandler as EventListener, { passive: true });
    }
  }

  private updateOverlayPositions(scroll: { x: number; y: number }) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const [key, el] of this.overlayElements) {
      const coords = this.overlayDocCoords.get(key);
      if (!coords) continue;

      const vx = coords.x - scroll.x;
      const vy = coords.y - scroll.y;

      if (vx + coords.w < 0 || vy + coords.h < 0 || vx > vw || vy > vh) {
        el.style.display = "none";
      } else {
        el.style.display = "";
        el.style.left = `${vx}px`;
        el.style.top = `${vy}px`;
      }
    }
  }

  private clearPageOverlays() {
    for (const el of this.overlayElements.values()) {
      el.remove();
    }
    this.overlayElements.clear();
    this.overlayDocCoords.clear();
    if (this.scrollHandler && this.scrollTarget) {
      this.scrollTarget.removeEventListener("scroll", this.scrollHandler as EventListener);
      this.scrollHandler = null;
      this.scrollTarget = null;
    }
  }

  private toggleOverlay(reportId: string) {
    const current = this.overlayVisibility.get(reportId) !== false;
    this.overlayVisibility.set(reportId, !current);
    this.renderPageOverlays();
    this.renderPanel();
    this.renderPageOverlays();
  }

  private listenForEscape() {
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.panelOpen) {
        this.closePanel();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);
  }
}

registerModule(new BugReportModule());
