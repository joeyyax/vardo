export const WIDGET_CSS = /* css */ `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #292524;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  /* Trigger button */
  .scope-trigger {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483646;
    width: 48px;
    height: 48px;
    border-radius: 14px;
    border: none;
    background: #b36b2d;
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 10px rgba(178, 107, 45, 0.3);
    transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
  }
  .scope-trigger:hover {
    transform: scale(1.05);
    background: #9a5c27;
    box-shadow: 0 4px 18px rgba(178, 107, 45, 0.35);
  }
  .scope-trigger .scope-trigger-mark {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    display: flex;
    align-items: center;
    gap: 0;
  }
  .scope-trigger .scope-trigger-mark .scope-bracket {
    opacity: 0.55;
  }

  /* Panel */
  .scope-panel {
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 2147483647;
    width: 400px;
    max-height: 540px;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 0 1px rgba(41,37,36,0.06);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: scope-slide-up 0.2s ease;
  }
  @keyframes scope-slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .scope-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #e7e5e4;
  }
  .scope-panel-header .scope-header-title {
    font-size: 14px;
    font-weight: 600;
    color: #292524;
  }
  .scope-panel-header button {
    background: none;
    border: none;
    cursor: pointer;
    color: #78716c;
    padding: 4px;
    border-radius: 6px;
    display: flex;
    align-items: center;
  }
  .scope-panel-header button:hover {
    background: #f5f5f4;
    color: #292524;
  }

  .scope-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  /* Panel footer */
  .scope-panel-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid #e7e5e4;
  }
  .scope-panel-footer .scope-footer-mark {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #a8a29e;
  }
  .scope-panel-footer .scope-footer-bracket {
    color: #d6d3d1;
  }
  .scope-panel-footer .scope-footer-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #d6d3d1;
    flex-shrink: 0;
  }
  .scope-panel-footer .scope-footer-status {
    font-size: 11px;
    color: #a8a29e;
    font-weight: 500;
  }

  /* Report list */
  .scope-report-list {
    list-style: none;
  }
  .scope-report-item {
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.1s;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .scope-report-item:hover {
    background: #f5f5f4;
  }
  .scope-report-item-desc {
    font-size: 13px;
    color: #292524;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scope-report-item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #78716c;
  }
  .scope-report-status {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .scope-status-new { background: #fef3c7; color: #92400e; }
  .scope-status-reviewed { background: #dbeafe; color: #1e40af; }
  .scope-status-resolved { background: #d1fae5; color: #065f46; }
  .scope-status-dismissed { background: #f5f5f4; color: #78716c; }

  /* Page badges */
  .scope-report-page-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scope-page-badge-current {
    background: #d1fae5;
    color: #065f46;
  }
  .scope-page-badge-other {
    background: #f5f5f4;
    color: #78716c;
  }

  /* Overlay toggle (eye icon) */
  .scope-overlay-toggle {
    background: none;
    border: none;
    cursor: pointer;
    color: #a8a29e;
    padding: 2px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .scope-overlay-toggle:hover {
    background: #f5f5f4;
    color: #57534e;
  }

  /* Intro / description */
  .scope-intro {
    font-size: 12px;
    color: #78716c;
    line-height: 1.5;
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f5f5f4;
  }

  .scope-section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #a8a29e;
    margin-bottom: 6px;
  }

  .scope-empty {
    text-align: center;
    color: #a8a29e;
    padding: 20px 16px;
    font-size: 12px;
  }
  .scope-empty-icon {
    display: block;
    margin: 0 auto 8px;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #f5f5f4;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .scope-empty-icon svg {
    width: 16px;
    height: 16px;
    color: #a8a29e;
  }

  /* Page URL context in form */
  .scope-page-context {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: #fafaf9;
    border: 1px solid #e7e5e4;
    border-radius: 8px;
    margin-bottom: 12px;
    font-size: 11px;
    color: #78716c;
    overflow: hidden;
  }
  .scope-page-context svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: #a8a29e;
  }
  .scope-page-context span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* New report button */
  .scope-new-report-btn {
    width: 100%;
    padding: 10px 16px;
    border: 1px dashed #d6d3d1;
    border-radius: 10px;
    background: none;
    color: #57534e;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
    margin-top: 8px;
  }
  .scope-new-report-btn:hover {
    border-color: #292524;
    color: #292524;
  }

  /* Screenshot gallery */
  .scope-screenshot-gallery {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }
  .scope-screenshot-thumb {
    position: relative;
    width: calc(50% - 4px);
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #e7e5e4;
  }
  .scope-screenshot-thumb img {
    width: 100%;
    display: block;
  }
  .scope-screenshot-remove {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: none;
    background: rgba(0,0,0,0.6);
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .scope-screenshot-thumb:hover .scope-screenshot-remove {
    opacity: 1;
  }

  /* Add another screenshot button */
  .scope-screenshot-add {
    width: 100%;
    padding: 8px 12px;
    border: 1px dashed #d6d3d1;
    border-radius: 8px;
    background: none;
    color: #57534e;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
    margin-bottom: 12px;
  }
  .scope-screenshot-add:hover {
    border-color: #292524;
    color: #292524;
  }

  /* Screenshot preview (legacy single) */
  .scope-screenshot-preview {
    position: relative;
    width: 100%;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #e7e5e4;
    margin-bottom: 12px;
  }
  .scope-screenshot-preview img {
    width: 100%;
    display: block;
  }

  .scope-screenshot-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  /* Form fields container */
  .scope-form-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Field labels */
  .scope-field-label {
    font-size: 11px;
    font-weight: 600;
    color: #57534e;
    margin-bottom: -2px;
  }

  /* Severity selector */
  .scope-severity-selector {
    display: flex;
    gap: 4px;
    margin-bottom: 4px;
  }
  .scope-severity-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 8px;
    border: 1px solid #e7e5e4;
    border-radius: 8px;
    background: #fff;
    color: #57534e;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
  }
  .scope-severity-btn:hover {
    border-color: #d6d3d1;
    background: #fafaf9;
  }
  .scope-severity-selected {
    border-color: #b36b2d;
    background: #fef7f0;
    color: #b36b2d;
    font-weight: 600;
  }
  .scope-severity-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .scope-severity-low { background: #94a3b8; }
  .scope-severity-medium { background: #3b82f6; }
  .scope-severity-high { background: #f97316; }
  .scope-severity-urgent { background: #ef4444; }

  /* Priority dot in cards */
  .scope-priority-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .scope-priority-low { background: #94a3b8; }
  .scope-priority-medium { background: #3b82f6; }
  .scope-priority-high { background: #f97316; }
  .scope-priority-urgent { background: #ef4444; }

  /* Comment count in card meta */
  .scope-comment-count {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: #78716c;
    font-size: 11px;
  }
  .scope-comment-count svg {
    width: 12px;
    height: 12px;
  }

  /* Assignee avatar in card meta */
  .scope-assignee-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #e7e5e4;
    color: #57534e;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
  }

  /* Form */
  .scope-textarea {
    width: 100%;
    min-height: 80px;
    padding: 10px 12px;
    border: 1px solid #d6d3d1;
    border-radius: 10px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: #292524;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
  }
  .scope-textarea:focus {
    border-color: #b36b2d;
  }
  .scope-textarea::placeholder {
    color: #a8a29e;
  }

  .scope-form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .scope-btn {
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: background 0.12s ease;
  }
  .scope-btn-primary {
    background: #b36b2d;
    color: #fff;
  }
  .scope-btn-primary:hover { background: #9a5c27; }
  .scope-btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .scope-btn-secondary {
    background: #f5f5f4;
    color: #57534e;
  }
  .scope-btn-secondary:hover { background: #e7e5e4; }

  /* Feedback */
  .scope-feedback {
    padding: 12px;
    border-radius: 10px;
    font-size: 13px;
    text-align: center;
  }
  .scope-feedback-success {
    background: #d1fae5;
    color: #065f46;
  }
  .scope-feedback-error {
    background: #fee2e2;
    color: #991b1b;
  }

  /* Success state */
  .scope-success-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px 0 8px;
  }
  .scope-success-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #d1fae5;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
    animation: scope-pop 0.3s ease;
  }
  .scope-success-icon svg {
    width: 24px;
    height: 24px;
    color: #059669;
  }
  @keyframes scope-pop {
    0% { transform: scale(0.5); opacity: 0; }
    70% { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }
  .scope-success-title {
    font-size: 15px;
    font-weight: 600;
    color: #292524;
    margin-bottom: 4px;
  }
  .scope-success-desc {
    font-size: 12px;
    color: #78716c;
    margin-bottom: 16px;
  }

  /* Selection overlay (full page, outside shadow DOM) */
  .scope-selection-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.1);
  }
  .scope-selection-rect {
    position: absolute;
    border: 2px solid #b36b2d;
    background: rgba(178, 107, 45, 0.08);
    border-radius: 4px;
    pointer-events: none;
  }

  /* Loading spinner */
  .scope-spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: scope-spin 0.6s linear infinite;
  }
  @keyframes scope-spin {
    to { transform: rotate(360deg); }
  }

  /* Squircle progressive enhancement */
  @supports (corner-shape: squircle) {
    .scope-trigger {
      corner-shape: squircle;
      corner-radius: 28px; /* 14px * 2 */
    }
    .scope-panel {
      corner-shape: squircle;
      corner-radius: 32px; /* 16px * 2 */
    }
    .scope-report-item {
      corner-shape: squircle;
      corner-radius: 20px;
    }
    .scope-btn {
      corner-shape: squircle;
      corner-radius: 16px;
    }
    .scope-textarea {
      corner-shape: squircle;
      corner-radius: 20px;
    }
    .scope-screenshot-thumb {
      corner-shape: squircle;
      corner-radius: 16px;
    }
    .scope-screenshot-preview {
      corner-shape: squircle;
      corner-radius: 20px;
    }
    .scope-new-report-btn,
    .scope-screenshot-add {
      corner-shape: squircle;
      corner-radius: 20px;
    }
    .scope-feedback {
      corner-shape: squircle;
      corner-radius: 20px;
    }
    .scope-page-context {
      corner-shape: squircle;
      corner-radius: 16px;
    }
    .scope-report-status,
    .scope-report-page-badge {
      corner-shape: squircle;
      corner-radius: 8px;
    }
    .scope-panel-header button {
      corner-shape: squircle;
      corner-radius: 12px;
    }
    .scope-severity-btn {
      corner-shape: squircle;
      corner-radius: 16px;
    }
  }
`;
