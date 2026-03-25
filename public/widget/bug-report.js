"use strict";var ScopeWidget=(()=>{var O=class{constructor(t,r){this.apiUrl=t;this.token=r;this.ready=!1;this.pendingCallbacks=new Map;this.handleMessage=t=>{let r=t.data;if(r?.type){if(r.type==="scope-auth"){let n=this.pendingCallbacks.get("auth");n&&(this.pendingCallbacks.delete("auth"),n(r))}else if(r.type==="scope-submit-result"){let n=this.pendingCallbacks.get("submit");n&&(this.pendingCallbacks.delete("submit"),n(r))}else if(r.type==="scope-reports"){let n=this.pendingCallbacks.get("reports");n&&(this.pendingCallbacks.delete("reports"),n(r))}}};this.iframe=document.createElement("iframe"),this.iframe.style.display="none",this.iframe.src=`${t}/widget/bridge?token=${r}`,document.body.appendChild(this.iframe),window.addEventListener("message",this.handleMessage)}waitForAuth(){return new Promise(t=>{this.pendingCallbacks.set("auth",r=>{this.ready=!0,t(r)})})}submitReport(t){return new Promise(r=>{this.pendingCallbacks.set("submit",n=>r(n)),this.postToBridge({type:"submit-report",payload:t})})}fetchReports(t,r){return new Promise(n=>{this.pendingCallbacks.set("reports",o=>{n(o.reports||[])}),this.postToBridge({type:"fetch-reports",organizationId:t,projectId:r})})}sendHeartbeat(t){this.postToBridge({type:"send-heartbeat",payload:t})}destroy(){window.removeEventListener("message",this.handleMessage),this.iframe.remove()}postToBridge(t){this.iframe.contentWindow?.postMessage(t,this.apiUrl)}};var k=[];function ee(){window.addEventListener("error",e=>{k.push({message:e.message||String(e.error),timestamp:Date.now()}),k.length>10&&k.shift()}),window.addEventListener("unhandledrejection",e=>{let t=e.reason instanceof Error?e.reason.message:String(e.reason);k.push({message:t,timestamp:Date.now()}),k.length>10&&k.shift()})}function te(){return k.length}function re(e){let t=navigator.userAgent;return{viewport:{width:window.innerWidth,height:window.innerHeight},browser:H(t),browserVersion:V(t),os:N(t),userAgent:t,env:e||void 0,referrer:document.referrer||void 0,documentReadyState:document.readyState,cache:Te(),cookieNames:Me(),connection:He(),memory:Ie(),recentErrors:k.length>0?[...k]:void 0}}function H(e){return e.includes("Firefox")?"Firefox":e.includes("Edg/")?"Edge":e.includes("Chrome")?"Chrome":e.includes("Safari")?"Safari":"Unknown"}function V(e){let t=[/Edg\/([\d.]+)/,/Chrome\/([\d.]+)/,/Firefox\/([\d.]+)/,/Version\/([\d.]+).*Safari/];for(let r of t){let n=e.match(r);if(n)return`${H(e)} ${n[1]}`}return H(e)}function N(e){return e.includes("Mac")?"macOS":e.includes("Win")?"Windows":e.includes("Linux")?"Linux":e.includes("iPhone")||e.includes("iPad")?"iOS":e.includes("Android")?"Android":"Unknown"}function Te(){try{let e=performance.getEntriesByType("navigation");if(e.length===0)return;let t=e[0];return{transferSize:t.transferSize??0,navigationType:t.type??"unknown",serviceWorkerControlled:!!navigator.serviceWorker?.controller}}catch{return}}function Me(){try{let e=document.cookie;return e?e.split(";").map(t=>t.trim().split("=")[0]).filter(Boolean):void 0}catch{return}}function He(){try{let e=navigator.connection;return e?{type:e.type,effectiveType:e.effectiveType,downlink:e.downlink,rtt:e.rtt}:void 0}catch{return}}function Ie(){try{let t=performance.memory;return t?{usedJSHeapSize:t.usedJSHeapSize,totalJSHeapSize:t.totalJSHeapSize,jsHeapSizeLimit:t.jsHeapSizeLimit}:void 0}catch{return}}var ne=`
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
`;var oe=[];function z(e){oe.push(e)}function se(){return oe}function ie(e,t){if(e.match(/^[a-z]+:\/\//i))return e;if(e.match(/^\/\//))return window.location.protocol+e;if(e.match(/^[a-z]+:/i))return e;let r=document.implementation.createHTMLDocument(),n=r.createElement("base"),o=r.createElement("a");return r.head.appendChild(n),r.body.appendChild(o),t&&(n.href=t),o.href=e,o.href}var ae=(()=>{let e=0,t=()=>`0000${(Math.random()*36**4<<0).toString(36)}`.slice(-4);return()=>(e+=1,`u${t()}${e}`)})();function E(e){let t=[];for(let r=0,n=e.length;r<n;r++)t.push(e[r]);return t}var R=null;function D(e={}){return R||(e.includeStyleProperties?(R=e.includeStyleProperties,R):(R=E(window.getComputedStyle(document.documentElement)),R))}function $(e,t){let n=(e.ownerDocument.defaultView||window).getComputedStyle(e).getPropertyValue(t);return n?parseFloat(n.replace("px","")):0}function Ae(e){let t=$(e,"border-left-width"),r=$(e,"border-right-width");return e.clientWidth+t+r}function Oe(e){let t=$(e,"border-top-width"),r=$(e,"border-bottom-width");return e.clientHeight+t+r}function j(e,t={}){let r=t.width||Ae(e),n=t.height||Oe(e);return{width:r,height:n}}function ce(){let e,t;try{t=process}catch{}let r=t&&t.env?t.env.devicePixelRatio:null;return r&&(e=parseInt(r,10),Number.isNaN(e)&&(e=1)),e||window.devicePixelRatio||1}var v=16384;function le(e){(e.width>v||e.height>v)&&(e.width>v&&e.height>v?e.width>e.height?(e.height*=v/e.width,e.width=v):(e.width*=v/e.height,e.height=v):e.width>v?(e.height*=v/e.width,e.width=v):(e.width*=v/e.height,e.height=v))}function P(e){return new Promise((t,r)=>{let n=new Image;n.onload=()=>{n.decode().then(()=>{requestAnimationFrame(()=>t(n))})},n.onerror=r,n.crossOrigin="anonymous",n.decoding="async",n.src=e})}async function ze(e){return Promise.resolve().then(()=>new XMLSerializer().serializeToString(e)).then(encodeURIComponent).then(t=>`data:image/svg+xml;charset=utf-8,${t}`)}async function de(e,t,r){let n="http://www.w3.org/2000/svg",o=document.createElementNS(n,"svg"),s=document.createElementNS(n,"foreignObject");return o.setAttribute("width",`${t}`),o.setAttribute("height",`${r}`),o.setAttribute("viewBox",`0 0 ${t} ${r}`),s.setAttribute("width","100%"),s.setAttribute("height","100%"),s.setAttribute("x","0"),s.setAttribute("y","0"),s.setAttribute("externalResourcesRequired","true"),o.appendChild(s),s.appendChild(e),ze(o)}var x=(e,t)=>{if(e instanceof t)return!0;let r=Object.getPrototypeOf(e);return r===null?!1:r.constructor.name===t.name||x(r,t)};function $e(e){let t=e.getPropertyValue("content");return`${e.cssText} content: '${t.replace(/'|"/g,"")}';`}function De(e,t){return D(t).map(r=>{let n=e.getPropertyValue(r),o=e.getPropertyPriority(r);return`${r}: ${n}${o?" !important":""};`}).join(" ")}function Fe(e,t,r,n){let o=`.${e}:${t}`,s=r.cssText?$e(r):De(r,n);return document.createTextNode(`${o}{${s}}`)}function pe(e,t,r,n){let o=window.getComputedStyle(e,r),s=o.getPropertyValue("content");if(s===""||s==="none")return;let i=ae();try{t.className=`${t.className} ${i}`}catch{return}let a=document.createElement("style");a.appendChild(Fe(i,r,o,n)),t.appendChild(a)}function ue(e,t,r){pe(e,t,":before",r),pe(e,t,":after",r)}var he="application/font-woff",me="image/jpeg",Ue={woff:he,woff2:he,ttf:"application/font-truetype",eot:"application/vnd.ms-fontobject",png:"image/png",jpg:me,jpeg:me,gif:"image/gif",tiff:"image/tiff",svg:"image/svg+xml",webp:"image/webp"};function We(e){let t=/\.([^./]*?)$/g.exec(e);return t?t[1]:""}function L(e){let t=We(e).toLowerCase();return Ue[t]||""}function Be(e){return e.split(/,/)[1]}function I(e){return e.search(/^(data:)/)!==-1}function _(e,t){return`data:${t};base64,${e}`}async function G(e,t,r){let n=await fetch(e,t);if(n.status===404)throw new Error(`Resource "${n.url}" not found`);let o=await n.blob();return new Promise((s,i)=>{let a=new FileReader;a.onerror=i,a.onloadend=()=>{try{s(r({res:n,result:a.result}))}catch(c){i(c)}},a.readAsDataURL(o)})}var q={};function Ve(e,t,r){let n=e.replace(/\?.*/,"");return r&&(n=e),/ttf|otf|eot|woff2?/i.test(n)&&(n=n.replace(/.*\//,"")),t?`[${t}]${n}`:n}async function T(e,t,r){let n=Ve(e,t,r.includeQueryParams);if(q[n]!=null)return q[n];r.cacheBust&&(e+=(/\?/.test(e)?"&":"?")+new Date().getTime());let o;try{let s=await G(e,r.fetchRequestInit,({res:i,result:a})=>(t||(t=i.headers.get("Content-Type")||""),Be(a)));o=_(s,t)}catch(s){o=r.imagePlaceholder||"";let i=`Failed to fetch resource: ${e}`;s&&(i=typeof s=="string"?s:s.message),i&&console.warn(i)}return q[n]=o,o}async function Ne(e){let t=e.toDataURL();return t==="data:,"?e.cloneNode(!1):P(t)}async function je(e,t){if(e.currentSrc){let s=document.createElement("canvas"),i=s.getContext("2d");s.width=e.clientWidth,s.height=e.clientHeight,i?.drawImage(e,0,0,s.width,s.height);let a=s.toDataURL();return P(a)}let r=e.poster,n=L(r),o=await T(r,n,t);return P(o)}async function qe(e,t){var r;try{if(!((r=e?.contentDocument)===null||r===void 0)&&r.body)return await A(e.contentDocument.body,t,!0)}catch{}return e.cloneNode(!1)}async function _e(e,t){return x(e,HTMLCanvasElement)?Ne(e):x(e,HTMLVideoElement)?je(e,t):x(e,HTMLIFrameElement)?qe(e,t):e.cloneNode(fe(e))}var Ge=e=>e.tagName!=null&&e.tagName.toUpperCase()==="SLOT",fe=e=>e.tagName!=null&&e.tagName.toUpperCase()==="SVG";async function Xe(e,t,r){var n,o;if(fe(t))return t;let s=[];return Ge(e)&&e.assignedNodes?s=E(e.assignedNodes()):x(e,HTMLIFrameElement)&&(!((n=e.contentDocument)===null||n===void 0)&&n.body)?s=E(e.contentDocument.body.childNodes):s=E(((o=e.shadowRoot)!==null&&o!==void 0?o:e).childNodes),s.length===0||x(e,HTMLVideoElement)||await s.reduce((i,a)=>i.then(()=>A(a,r)).then(c=>{c&&t.appendChild(c)}),Promise.resolve()),t}function Ye(e,t,r){let n=t.style;if(!n)return;let o=window.getComputedStyle(e);o.cssText?(n.cssText=o.cssText,n.transformOrigin=o.transformOrigin):D(r).forEach(s=>{let i=o.getPropertyValue(s);s==="font-size"&&i.endsWith("px")&&(i=`${Math.floor(parseFloat(i.substring(0,i.length-2)))-.1}px`),x(e,HTMLIFrameElement)&&s==="display"&&i==="inline"&&(i="block"),s==="d"&&t.getAttribute("d")&&(i=`path(${t.getAttribute("d")})`),n.setProperty(s,i,o.getPropertyPriority(s))})}function Je(e,t){x(e,HTMLTextAreaElement)&&(t.innerHTML=e.value),x(e,HTMLInputElement)&&t.setAttribute("value",e.value)}function Ke(e,t){if(x(e,HTMLSelectElement)){let n=Array.from(t.children).find(o=>e.value===o.getAttribute("value"));n&&n.setAttribute("selected","")}}function Qe(e,t,r){return x(t,Element)&&(Ye(e,t,r),ue(e,t,r),Je(e,t),Ke(e,t)),t}async function Ze(e,t){let r=e.querySelectorAll?e.querySelectorAll("use"):[];if(r.length===0)return e;let n={};for(let s=0;s<r.length;s++){let a=r[s].getAttribute("xlink:href");if(a){let c=e.querySelector(a),d=document.querySelector(a);!c&&d&&!n[a]&&(n[a]=await A(d,t,!0))}}let o=Object.values(n);if(o.length){let s="http://www.w3.org/1999/xhtml",i=document.createElementNS(s,"svg");i.setAttribute("xmlns",s),i.style.position="absolute",i.style.width="0",i.style.height="0",i.style.overflow="hidden",i.style.display="none";let a=document.createElementNS(s,"defs");i.appendChild(a);for(let c=0;c<o.length;c++)a.appendChild(o[c]);e.appendChild(i)}return e}async function A(e,t,r){return!r&&t.filter&&!t.filter(e)?null:Promise.resolve(e).then(n=>_e(n,t)).then(n=>Xe(e,n,t)).then(n=>Qe(e,n,t)).then(n=>Ze(n,t))}var ge=/url\((['"]?)([^'"]+?)\1\)/g,et=/url\([^)]+\)\s*format\((["']?)([^"']+)\1\)/g,tt=/src:\s*(?:url\([^)]+\)\s*format\([^)]+\)[,;]\s*)+/g;function rt(e){let t=e.replace(/([.*+?^${}()|\[\]\/\\])/g,"\\$1");return new RegExp(`(url\\(['"]?)(${t})(['"]?\\))`,"g")}function nt(e){let t=[];return e.replace(ge,(r,n,o)=>(t.push(o),r)),t.filter(r=>!I(r))}async function ot(e,t,r,n,o){try{let s=r?ie(t,r):t,i=L(t),a;if(o){let c=await o(s);a=_(c,i)}else a=await T(s,i,n);return e.replace(rt(t),`$1${a}$3`)}catch{}return e}function st(e,{preferredFontFormat:t}){return t?e.replace(tt,r=>{for(;;){let[n,,o]=et.exec(r)||[];if(!o)return"";if(o===t)return`src: ${n};`}}):e}function X(e){return e.search(ge)!==-1}async function F(e,t,r){if(!X(e))return e;let n=st(e,r);return nt(n).reduce((s,i)=>s.then(a=>ot(a,i,t,r)),Promise.resolve(n))}async function M(e,t,r){var n;let o=(n=t.style)===null||n===void 0?void 0:n.getPropertyValue(e);if(o){let s=await F(o,null,r);return t.style.setProperty(e,s,t.style.getPropertyPriority(e)),!0}return!1}async function it(e,t){await M("background",e,t)||await M("background-image",e,t),await M("mask",e,t)||await M("-webkit-mask",e,t)||await M("mask-image",e,t)||await M("-webkit-mask-image",e,t)}async function at(e,t){let r=x(e,HTMLImageElement);if(!(r&&!I(e.src))&&!(x(e,SVGImageElement)&&!I(e.href.baseVal)))return;let n=r?e.src:e.href.baseVal,o=await T(n,L(n),t);await new Promise((s,i)=>{e.onload=s,e.onerror=t.onImageErrorHandler?(...c)=>{try{s(t.onImageErrorHandler(...c))}catch(d){i(d)}}:i;let a=e;a.decode&&(a.decode=s),a.loading==="lazy"&&(a.loading="eager"),r?(e.srcset="",e.src=o):e.href.baseVal=o})}async function ct(e,t){let n=E(e.childNodes).map(o=>Y(o,t));await Promise.all(n).then(()=>e)}async function Y(e,t){x(e,Element)&&(await it(e,t),await at(e,t),await ct(e,t))}function be(e,t){let{style:r}=e;t.backgroundColor&&(r.backgroundColor=t.backgroundColor),t.width&&(r.width=`${t.width}px`),t.height&&(r.height=`${t.height}px`);let n=t.style;return n!=null&&Object.keys(n).forEach(o=>{r[o]=n[o]}),e}var ye={};async function xe(e){let t=ye[e];if(t!=null)return t;let n=await(await fetch(e)).text();return t={url:e,cssText:n},ye[e]=t,t}async function we(e,t){let r=e.cssText,n=/url\(["']?([^"')]+)["']?\)/g,s=(r.match(/url\([^)]+\)/g)||[]).map(async i=>{let a=i.replace(n,"$1");return a.startsWith("https://")||(a=new URL(a,e.url).href),G(a,t.fetchRequestInit,({result:c})=>(r=r.replace(i,`url(${c})`),[i,c]))});return Promise.all(s).then(()=>r)}function ve(e){if(e==null)return[];let t=[],r=/(\/\*[\s\S]*?\*\/)/gi,n=e.replace(r,""),o=new RegExp("((@.*?keyframes [\\s\\S]*?){([\\s\\S]*?}\\s*?)})","gi");for(;;){let c=o.exec(n);if(c===null)break;t.push(c[0])}n=n.replace(o,"");let s=/@import[\s\S]*?url\([^)]*\)[\s\S]*?;/gi,i="((\\s*?(?:\\/\\*[\\s\\S]*?\\*\\/)?\\s*?@media[\\s\\S]*?){([\\s\\S]*?)}\\s*?})|(([\\s\\S]*?){([\\s\\S]*?)})",a=new RegExp(i,"gi");for(;;){let c=s.exec(n);if(c===null){if(c=a.exec(n),c===null)break;s.lastIndex=a.lastIndex}else a.lastIndex=s.lastIndex;t.push(c[0])}return t}async function lt(e,t){let r=[],n=[];return e.forEach(o=>{if("cssRules"in o)try{E(o.cssRules||[]).forEach((s,i)=>{if(s.type===CSSRule.IMPORT_RULE){let a=i+1,c=s.href,d=xe(c).then(l=>we(l,t)).then(l=>ve(l).forEach(h=>{try{o.insertRule(h,h.startsWith("@import")?a+=1:o.cssRules.length)}catch(y){console.error("Error inserting rule from remote css",{rule:h,error:y})}})).catch(l=>{console.error("Error loading remote css",l.toString())});n.push(d)}})}catch(s){let i=e.find(a=>a.href==null)||document.styleSheets[0];o.href!=null&&n.push(xe(o.href).then(a=>we(a,t)).then(a=>ve(a).forEach(c=>{i.insertRule(c,i.cssRules.length)})).catch(a=>{console.error("Error loading remote stylesheet",a)})),console.error("Error inlining remote css file",s)}}),Promise.all(n).then(()=>(e.forEach(o=>{if("cssRules"in o)try{E(o.cssRules||[]).forEach(s=>{r.push(s)})}catch(s){console.error(`Error while reading CSS rules from ${o.href}`,s)}}),r))}function dt(e){return e.filter(t=>t.type===CSSRule.FONT_FACE_RULE).filter(t=>X(t.style.getPropertyValue("src")))}async function pt(e,t){if(e.ownerDocument==null)throw new Error("Provided element is not within a Document");let r=E(e.ownerDocument.styleSheets),n=await lt(r,t);return dt(n)}function Ce(e){return e.trim().replace(/["']/g,"")}function ut(e){let t=new Set;function r(n){(n.style.fontFamily||getComputedStyle(n).fontFamily).split(",").forEach(s=>{t.add(Ce(s))}),Array.from(n.children).forEach(s=>{s instanceof HTMLElement&&r(s)})}return r(e),t}async function Ee(e,t){let r=await pt(e,t),n=ut(e);return(await Promise.all(r.filter(s=>n.has(Ce(s.style.fontFamily))).map(s=>{let i=s.parentStyleSheet?s.parentStyleSheet.href:null;return F(s.cssText,i,t)}))).join(`
`)}async function Se(e,t){let r=t.fontEmbedCSS!=null?t.fontEmbedCSS:t.skipFonts?null:await Ee(e,t);if(r){let n=document.createElement("style"),o=document.createTextNode(r);n.appendChild(o),e.firstChild?e.insertBefore(n,e.firstChild):e.appendChild(n)}}async function ht(e,t={}){let{width:r,height:n}=j(e,t),o=await A(e,t,!0);return await Se(o,t),await Y(o,t),be(o,t),await de(o,r,n)}async function mt(e,t={}){let{width:r,height:n}=j(e,t),o=await ht(e,t),s=await P(o),i=document.createElement("canvas"),a=i.getContext("2d"),c=t.pixelRatio||ce(),d=t.canvasWidth||r,l=t.canvasHeight||n;return i.width=d*c,i.height=l*c,t.skipAutoScale||le(i),i.style.width=`${d}`,i.style.height=`${l}`,t.backgroundColor&&(a.fillStyle=t.backgroundColor,a.fillRect(0,0,i.width,i.height)),a.drawImage(s,0,0,i.width,i.height),i}async function ke(e,t={}){return(await mt(e,t)).toDataURL()}function Re(e){return new Promise(t=>{let r=document.createElement("div");r.className="scope-selection-overlay",Object.assign(r.style,{position:"fixed",inset:"0",zIndex:"2147483647",cursor:"crosshair",background:"rgba(0, 0, 0, 0.15)"});let n=document.createElement("div");Object.assign(n.style,{position:"absolute",top:"16px",left:"50%",transform:"translateX(-50%)",background:"#292524",color:"#fff",padding:"8px 16px",borderRadius:"10px",fontSize:"13px",fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",fontWeight:"500",pointerEvents:"none",boxShadow:"0 4px 12px rgba(0,0,0,0.2)",whiteSpace:"nowrap",zIndex:"1"}),n.textContent="Click and drag to select the problem area \xB7 Esc to cancel",r.appendChild(n);let o=document.createElement("div");Object.assign(o.style,{position:"absolute",border:"2px solid #b36b2d",background:"rgba(178, 107, 45, 0.08)",borderRadius:"4px",pointerEvents:"none",display:"none"}),r.appendChild(o);let s=0,i=0,a=!1;function c(){r.remove(),document.removeEventListener("keydown",d)}function d(l){l.key==="Escape"&&(c(),t(null))}r.addEventListener("mousedown",l=>{s=l.clientX,i=l.clientY,a=!0,o.style.display="block",o.style.left=`${s}px`,o.style.top=`${i}px`,o.style.width="0px",o.style.height="0px"}),r.addEventListener("mousemove",l=>{if(!a)return;let h=Math.min(s,l.clientX),y=Math.min(i,l.clientY),b=Math.abs(l.clientX-s),f=Math.abs(l.clientY-i);o.style.left=`${h}px`,o.style.top=`${y}px`,o.style.width=`${b}px`,o.style.height=`${f}px`}),r.addEventListener("mouseup",l=>{if(!a)return;a=!1;let h=Math.min(s,l.clientX),y=Math.min(i,l.clientY),b=Math.abs(l.clientX-s),f=Math.abs(l.clientY-i);if(c(),b<10||f<10){t(null);return}t({x:h,y,width:b,height:f})}),document.addEventListener("keydown",d),document.body.appendChild(r)})}function J(){let t=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);for(;t&&t!==document.body&&t!==document.documentElement;){let{overflowY:r}=getComputedStyle(t);if((r==="auto"||r==="scroll")&&t.scrollHeight>t.clientHeight)return t;t=t.parentElement}return null}function W(){let e=J();return e?{x:e.scrollLeft,y:e.scrollTop}:{x:window.scrollX,y:window.scrollY}}var U=200;async function Pe(e,t){try{let r=await ke(document.body,{width:window.innerWidth,height:window.innerHeight,style:{transform:"none",transformOrigin:"top left"},filter:l=>!(l===t||l.classList?.contains("scope-selection-overlay"))}),n=await ft(r),o=window.devicePixelRatio||1,s={x:Math.max(0,e.x-U),y:Math.max(0,e.y-U),width:0,height:0};s.width=Math.min(window.innerWidth,e.x+e.width+U)-s.x,s.height=Math.min(window.innerHeight,e.y+e.height+U)-s.y;let i=document.createElement("canvas");i.width=s.width*o,i.height=s.height*o;let a=i.getContext("2d");a.scale(o,o),a.drawImage(n,s.x*o,s.y*o,s.width*o,s.height*o,0,0,s.width,s.height);let c=e.x-s.x,d=e.y-s.y;return a.fillStyle="rgba(0, 0, 0, 0.35)",a.fillRect(0,0,s.width,d),a.fillRect(0,d+e.height,s.width,s.height-d-e.height),a.fillRect(0,d,c,e.height),a.fillRect(c+e.width,d,s.width-c-e.width,e.height),a.strokeStyle="#b36b2d",a.lineWidth=2,a.strokeRect(c,d,e.width,e.height),{dataUrl:i.toDataURL("image/png"),selectionRect:{...e},expandedRect:{...s},scrollOffset:W()}}catch(r){return console.warn("[Scope] Screenshot capture failed:",r),null}}function ft(e){return new Promise((t,r)=>{let n=new Image;n.onload=()=>t(n),n.onerror=r,n.src=e})}function g(e,t){let r=document.createElementNS("http://www.w3.org/2000/svg",e);for(let[n,o]of Object.entries(t))r.setAttribute(n,o);return r}function gt(){let e=g("svg",{width:"16",height:"16",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"});return e.appendChild(g("line",{x1:"18",y1:"6",x2:"6",y2:"18"})),e.appendChild(g("line",{x1:"6",y1:"6",x2:"18",y2:"18"})),e}function bt(e){let t=g("svg",{width:"14",height:"14",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"});return e?(t.appendChild(g("path",{d:"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"})),t.appendChild(g("circle",{cx:"12",cy:"12",r:"3"}))):(t.appendChild(g("path",{d:"M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"})),t.appendChild(g("path",{d:"M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"})),t.appendChild(g("line",{x1:"1",y1:"1",x2:"23",y2:"23"}))),t}function yt(){let e=g("svg",{width:"24",height:"24",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2.5","stroke-linecap":"round","stroke-linejoin":"round"});return e.appendChild(g("polyline",{points:"20 6 9 17 4 12"})),e}function xt(){let e=g("svg",{width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"});return e.appendChild(g("circle",{cx:"12",cy:"12",r:"10"})),e.appendChild(g("line",{x1:"2",y1:"12",x2:"22",y2:"12"})),e.appendChild(g("path",{d:"M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"})),e}function wt(){let e=g("svg",{width:"12",height:"12",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"});return e.appendChild(g("path",{d:"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"})),e}function vt(){let e=g("svg",{width:"16",height:"16",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"});return e.appendChild(g("polyline",{points:"22 12 16 12 14 15 10 15 8 12 2 12"})),e.appendChild(g("path",{d:"M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"})),e}function Le(e){try{return new Date(e).toLocaleDateString(void 0,{month:"short",day:"numeric"})}catch{return""}}function Ct(e){let t=e.createdAt,r=e.updatedAt;if(r&&r!==t){let n=new Date(t).getTime(),o=new Date(r).getTime();if(Math.abs(o-n)>6e4)return`Updated ${Le(r)}`}return Le(t)}var Et={low:"#94a3b8",medium:"#3b82f6",high:"#f97316",urgent:"#ef4444"};function St(e,t){let r=document.createElement("span");r.className=e;let n=document.createElement("span");n.className=t,n.textContent="[";let o=document.createTextNode("scope"),s=document.createElement("span");return s.className=t,s.textContent="]",r.appendChild(n),r.appendChild(o),r.appendChild(s),r}function kt(){let e=document.createElement("span");e.className="scope-trigger-mark";let t=document.createElement("span");t.className="scope-bracket",t.textContent="[";let r=document.createElement("span");r.textContent="s";let n=document.createElement("span");return n.className="scope-bracket",n.textContent="]",e.appendChild(t),e.appendChild(r),e.appendChild(n),e}function Rt(e,t){let r=document.createElement("div");r.className="scope-panel-header";let n=document.createElement("span");n.className="scope-header-title",n.textContent=e,r.appendChild(n);let o=document.createElement("button");return o.appendChild(gt()),o.addEventListener("click",t),r.appendChild(o),r}function Pt(){let e=document.createElement("div");e.className="scope-panel-footer",e.appendChild(St("scope-footer-mark","scope-footer-bracket"));let t=document.createElement("span");t.className="scope-footer-dot",e.appendChild(t);let r=document.createElement("span");return r.className="scope-footer-status",r.textContent="Hidden from public",e.appendChild(r),e}var K=class{constructor(){this.id="bug-report";this.reports=[];this.screenshots=[];this.panelOpen=!1;this.view="list";this.overlayElements=new Map;this.overlayDocCoords=new Map;this.overlayVisibility=new Map;this.selectedPriority=null;this.scrollHandler=null;this.scrollTarget=null;this.escapeHandler=null}init(t){this.ctx=t,this.auth=t.auth,this.reports=t.auth.reports||[],this.renderTrigger(),this.listenForEscape()}destroy(){this.clearPageOverlays(),this.escapeHandler&&document.removeEventListener("keydown",this.escapeHandler)}get shadow(){return this.ctx.shadow}renderTrigger(){this.clearPanel();let t=document.createElement("button");t.className="scope-trigger",t.title="Report an issue",t.appendChild(kt()),t.addEventListener("click",()=>this.togglePanel()),this.shadow.appendChild(t)}togglePanel(){this.panelOpen?this.closePanel():this.openPanel()}openPanel(){this.panelOpen=!0,this.view="list",this.screenshots=[],this.renderPanel(),this.renderPageOverlays()}closePanel(){this.panelOpen=!1,this.screenshots=[],this.clearPageOverlays(),this.clearPanel()}hidePanel(){this.panelOpen=!1,this.clearPageOverlays(),this.clearPanel()}clearPanel(){let t=this.shadow.querySelector(".scope-panel");t&&t.remove()}renderPanel(){this.clearPanel();let t=document.createElement("div");t.className="scope-panel";let r=this.view==="form"?"Report an Issue":"Feedback";t.appendChild(Rt(r,()=>this.closePanel()));let n=document.createElement("div");n.className="scope-panel-body",this.view==="list"?this.renderReportList(n):this.view==="form"?this.renderForm(n):this.view==="success"&&this.renderSuccess(n),t.appendChild(n),t.appendChild(Pt()),this.shadow.appendChild(t)}renderReportList(t){let r=document.createElement("div");r.className="scope-intro",r.textContent="Spotted something off? Capture the problem area, add a description, and we'll take care of it.",t.appendChild(r);let n=document.createElement("button");n.className="scope-btn scope-btn-primary",n.style.width="100%",n.style.marginBottom="16px",n.textContent="Report an Issue",n.addEventListener("click",()=>this.startCapture()),t.appendChild(n);let o=document.createElement("div");if(o.className="scope-section-label",o.textContent="Previous Reports",t.appendChild(o),this.reports.length===0){let s=document.createElement("div");s.className="scope-empty";let i=document.createElement("div");i.className="scope-empty-icon",i.appendChild(vt()),s.appendChild(i);let a=document.createElement("div");a.textContent="No reports yet",s.appendChild(a),t.appendChild(s)}else{let s=document.createElement("ul");s.className="scope-report-list";let i=window.location.href,a=[...this.reports].sort((c,d)=>{let l=c.pageUrl===i?0:1,h=d.pageUrl===i?0:1;return l!==h?l-h:new Date(d.createdAt).getTime()-new Date(c.createdAt).getTime()});for(let c of a){let d=document.createElement("li");d.className="scope-report-item",d.addEventListener("click",()=>{window.open(`${this.ctx.config.apiUrl}/projects/${this.auth.defaultProjectId}`,"_blank")});let l=document.createElement("div");if(l.style.display="flex",l.style.alignItems="center",l.style.gap="6px",c.priority&&Et[c.priority]){let u=document.createElement("span");u.className=`scope-priority-dot scope-priority-${c.priority}`,l.appendChild(u)}let h=document.createElement("div");h.className="scope-report-item-desc",h.style.flex="1",h.textContent=c.description,l.appendChild(h);let y=c.pageUrl===i,b=!!c.metadata?.screenshots?.length;if(y&&b){let u=document.createElement("button");u.className="scope-overlay-toggle";let S=this.overlayVisibility.get(c.id)!==!1;u.appendChild(bt(S)),u.title=S?"Hide overlay":"Show overlay",u.addEventListener("click",C=>{C.stopPropagation(),this.toggleOverlay(c.id)}),l.appendChild(u)}d.appendChild(l);let f=document.createElement("div");f.className="scope-report-item-meta";let p=document.createElement("span");p.className=`scope-report-status scope-status-${c.status}`,p.textContent=c.status,f.appendChild(p);let m=document.createElement("span");if(y)m.className="scope-report-page-badge scope-page-badge-current",m.textContent="This page";else if(c.pageUrl){m.className="scope-report-page-badge scope-page-badge-other";try{let u=new URL(c.pageUrl);m.textContent=u.pathname.length>20?u.pathname.slice(0,18)+"\u2026":u.pathname}catch{m.textContent="Other page"}}if(m.textContent&&f.appendChild(m),c.commentCount&&c.commentCount>0){let u=document.createElement("span");u.className="scope-comment-count",u.appendChild(wt());let S=document.createTextNode(String(c.commentCount));u.appendChild(S),f.appendChild(u)}if(c.assignee){let u=document.createElement("span");u.className="scope-assignee-avatar",u.textContent=(c.assignee.name||c.assignee.email||"?").charAt(0).toUpperCase(),u.title=c.assignee.name||c.assignee.email,f.appendChild(u)}let w=document.createElement("span");w.textContent=Ct(c),f.appendChild(w),d.appendChild(f),s.appendChild(d)}t.appendChild(s)}}async startCapture(){this.hidePanel();let t=await Re(this.ctx.host);if(!t){this.panelOpen=!0,this.view=this.screenshots.length>0?"form":"list",this.renderPanel(),this.view==="list"&&this.renderPageOverlays();return}let r=await Pe(t,this.ctx.host);r&&this.screenshots.push(r),this.view="form",this.panelOpen=!0,this.renderPanel()}renderForm(t){let r=document.createElement("div");r.className="scope-page-context",r.appendChild(xt());let n=document.createElement("span");try{let p=new URL(window.location.href);n.textContent=p.host+p.pathname}catch{n.textContent=window.location.href}if(r.appendChild(n),t.appendChild(r),this.screenshots.length>0){let p=document.createElement("div");p.className="scope-screenshot-gallery";for(let w=0;w<this.screenshots.length;w++){let u=document.createElement("div");u.className="scope-screenshot-thumb";let S=document.createElement("img");S.src=this.screenshots[w].dataUrl,S.alt=`Screenshot ${w+1}`,u.appendChild(S);let C=document.createElement("button");C.className="scope-screenshot-remove",C.textContent="\xD7",C.title="Remove",C.addEventListener("click",()=>{this.screenshots.splice(w,1),this.renderPanel()}),u.appendChild(C),p.appendChild(u)}t.appendChild(p);let m=document.createElement("button");m.className="scope-screenshot-add",m.textContent="+ Add Another Screenshot",m.addEventListener("click",()=>this.startCapture()),t.appendChild(m)}else{let p=document.createElement("button");p.className="scope-new-report-btn",p.textContent="+ Add Screenshot",p.style.marginTop="0",p.style.marginBottom="12px",p.addEventListener("click",()=>this.startCapture()),t.appendChild(p)}let o=document.createElement("div");o.className="scope-form-fields";let s=document.createElement("label");s.className="scope-field-label",s.textContent="Severity",o.appendChild(s);let i=document.createElement("div");i.className="scope-severity-selector";let a=[{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"urgent",label:"Urgent"}];for(let p of a){let m=document.createElement("button");m.className=`scope-severity-btn${this.selectedPriority===p.value?" scope-severity-selected":""}`,m.type="button",m.setAttribute("data-priority",p.value);let w=document.createElement("span");w.className=`scope-severity-dot scope-severity-${p.value}`,m.appendChild(w);let u=document.createTextNode(p.label);m.appendChild(u),m.addEventListener("click",()=>{this.selectedPriority=this.selectedPriority===p.value?null:p.value,i.querySelectorAll(".scope-severity-btn").forEach(C=>{C.getAttribute("data-priority")===this.selectedPriority?C.classList.add("scope-severity-selected"):C.classList.remove("scope-severity-selected")})}),i.appendChild(m)}o.appendChild(i);let c=document.createElement("label");c.className="scope-field-label",c.textContent="What happened?",o.appendChild(c);let d=document.createElement("textarea");d.className="scope-textarea",d.placeholder="Describe what went wrong...",d.setAttribute("rows","2"),o.appendChild(d);let l=document.createElement("label");l.className="scope-field-label",l.textContent="What did you expect?",o.appendChild(l);let h=document.createElement("textarea");h.className="scope-textarea",h.placeholder="What should have happened instead?",h.setAttribute("rows","2"),o.appendChild(h),t.appendChild(o);let y=document.createElement("div");y.className="scope-form-actions";let b=document.createElement("button");b.className="scope-btn scope-btn-secondary",b.textContent="Back",b.addEventListener("click",()=>{this.view="list",this.screenshots=[],this.selectedPriority=null,this.renderPanel(),this.renderPageOverlays()}),y.appendChild(b);let f=document.createElement("button");f.className="scope-btn scope-btn-primary",f.textContent="Submit",f.addEventListener("click",()=>{let p=d.value.trim(),m=h.value.trim(),w="";p&&m?w=`What happened:
${p}

Expected behavior:
${m}`:p&&(w=p),this.handleSubmit(w,f)}),y.appendChild(f),t.appendChild(y),requestAnimationFrame(()=>d.focus())}async handleSubmit(t,r){if(!t.trim()){let a=this.shadow.querySelector(".scope-textarea");a&&(a.style.borderColor="#ef4444",setTimeout(()=>a.style.borderColor="",1500));return}r.disabled=!0;let n=document.createElement("span");n.className="scope-spinner",r.textContent="",r.appendChild(n);let o=re(this.ctx.config.env),s={organizationId:this.auth.organizationId,projectId:this.auth.defaultProjectId,clientId:this.auth.clientId,scopeClientId:this.auth.scopeClientId,description:t.trim(),pageUrl:window.location.href,priority:this.selectedPriority,metadata:o,screenshots:this.screenshots},i=await this.ctx.bridge.submitReport(s);if(!i.success){this.renderFeedback("error",i.error||"Something went wrong"),r.disabled=!1,r.textContent="Submit";return}i.report&&this.reports.unshift(i.report),this.view="success",this.screenshots=[],this.selectedPriority=null,this.renderPanel()}renderSuccess(t){let r=document.createElement("div");r.className="scope-success-content";let n=document.createElement("div");n.className="scope-success-icon",n.appendChild(yt()),r.appendChild(n);let o=document.createElement("div");o.className="scope-success-title",o.textContent="Report submitted",r.appendChild(o);let s=document.createElement("div");s.className="scope-success-desc",s.textContent="We'll look into this and follow up.",r.appendChild(s);let i=document.createElement("button");i.className="scope-btn scope-btn-secondary",i.textContent="Back to Reports",i.style.width="100%",i.addEventListener("click",()=>{this.view="list",this.renderPanel(),this.renderPageOverlays()}),r.appendChild(i),t.appendChild(r)}renderFeedback(t,r){let n=this.shadow.querySelector(".scope-panel-body");if(!n)return;let o=n.querySelector(".scope-feedback");o&&o.remove();let s=document.createElement("div");s.className=`scope-feedback scope-feedback-${t}`,s.textContent=r,n.insertBefore(s,n.firstChild),t==="error"&&setTimeout(()=>s.remove(),4e3)}renderPageOverlays(){this.clearPageOverlays();let t=window.location.href,r=J(),n=W();for(let o of this.reports){if(o.pageUrl!==t)continue;let s=o.metadata?.screenshots;if(s?.length&&(this.overlayVisibility.has(o.id)||this.overlayVisibility.set(o.id,!0),!!this.overlayVisibility.get(o.id)))for(let i of s){if(!i.selectionRect)continue;let{x:a,y:c,width:d,height:l}=i.selectionRect,h=a+(i.scrollOffset?.x??0),y=c+(i.scrollOffset?.y??0),b=document.createElement("div");b.setAttribute("data-scope-overlay",o.id),Object.assign(b.style,{position:"fixed",width:`${d}px`,height:`${l}px`,border:"2px solid #b36b2d",background:"rgba(178, 107, 45, 0.08)",borderRadius:"4px",pointerEvents:"none",zIndex:"2147483640"});let f=document.createElement("div");Object.assign(f.style,{position:"absolute",bottom:"-22px",left:"0",background:"#b36b2d",color:"#fff",fontSize:"10px",fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",fontWeight:"600",padding:"2px 6px",borderRadius:"3px",whiteSpace:"nowrap",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis"}),f.textContent=o.description.length>30?o.description.slice(0,28)+"\u2026":o.description,b.appendChild(f),document.body.appendChild(b);let p=`${o.id}-${h}-${y}`;this.overlayElements.set(p,b),this.overlayDocCoords.set(p,{x:h,y,w:d,h:l})}}this.updateOverlayPositions(n),this.overlayElements.size>0&&!this.scrollHandler&&(this.scrollTarget=r||window,this.scrollHandler=()=>this.updateOverlayPositions(W()),this.scrollTarget.addEventListener("scroll",this.scrollHandler,{passive:!0}))}updateOverlayPositions(t){let r=window.innerWidth,n=window.innerHeight;for(let[o,s]of this.overlayElements){let i=this.overlayDocCoords.get(o);if(!i)continue;let a=i.x-t.x,c=i.y-t.y;a+i.w<0||c+i.h<0||a>r||c>n?s.style.display="none":(s.style.display="",s.style.left=`${a}px`,s.style.top=`${c}px`)}}clearPageOverlays(){for(let t of this.overlayElements.values())t.remove();this.overlayElements.clear(),this.overlayDocCoords.clear(),this.scrollHandler&&this.scrollTarget&&(this.scrollTarget.removeEventListener("scroll",this.scrollHandler),this.scrollHandler=null,this.scrollTarget=null)}toggleOverlay(t){let r=this.overlayVisibility.get(t)!==!1;this.overlayVisibility.set(t,!r),this.renderPageOverlays(),this.renderPanel(),this.renderPageOverlays()}listenForEscape(){this.escapeHandler=t=>{t.key==="Escape"&&this.panelOpen&&this.closePanel()},document.addEventListener("keydown",this.escapeHandler)}};z(new K);var Lt=1e4,Q=class{constructor(){this.id="metrics";this.timer=null;this.observers=[];this.resourceErrorHandler=null;this.consoleErrorCount=0;this.consoleWarnCount=0;this.resourceFailureCount=0;this.lcpValue=null;this.clsValue=0;this.inpValue=null;this.eventDurations=[];this.origConsoleError=null;this.origConsoleWarn=null}init(t){this.ctx=t,this.installConsoleInterceptors(),this.installResourceErrorListener(),this.startPerformanceObservers(),this.timer=setTimeout(()=>this.sendHeartbeat(),Lt)}destroy(){this.timer&&clearTimeout(this.timer),this.restoreConsole(),this.disconnectObservers(),this.removeResourceErrorListener()}installConsoleInterceptors(){this.origConsoleError=console.error,this.origConsoleWarn=console.warn;let t=this.origConsoleError,r=this.origConsoleWarn,n=()=>{this.consoleErrorCount++},o=()=>{this.consoleWarnCount++};console.error=function(...s){n(),t.apply(console,s)},console.warn=function(...s){o(),r.apply(console,s)}}restoreConsole(){this.origConsoleError&&(console.error=this.origConsoleError),this.origConsoleWarn&&(console.warn=this.origConsoleWarn)}installResourceErrorListener(){this.resourceErrorHandler=t=>{let r=t.target;if(!r)return;let n=r.tagName?.toLowerCase();(n==="script"||n==="img"||n==="link")&&this.resourceFailureCount++},window.addEventListener("error",this.resourceErrorHandler,!0)}removeResourceErrorListener(){this.resourceErrorHandler&&window.removeEventListener("error",this.resourceErrorHandler,!0)}startPerformanceObservers(){this.tryObserver("largest-contentful-paint",t=>{let r=t[t.length-1];r&&(this.lcpValue=r.startTime)}),this.tryObserver("layout-shift",t=>{for(let r of t){let n=r;!n.hadRecentInput&&n.value&&(this.clsValue+=n.value)}}),this.tryObserver("event",t=>{for(let r of t)this.eventDurations.push(r.duration)},{durationThreshold:16})}tryObserver(t,r,n){try{let o=new PerformanceObserver(s=>r(s.getEntries()));o.observe({type:t,buffered:!0,...n}),this.observers.push(o)}catch{}}disconnectObservers(){for(let t of this.observers)t.disconnect();this.observers=[]}computeInp(){if(this.eventDurations.length===0)return null;let t=[...this.eventDurations].sort((n,o)=>n-o),r=Math.min(Math.ceil(t.length*.98)-1,t.length-1);return t[r]}collectNavigation(){try{let t=performance.getEntriesByType("navigation");if(t.length===0)return null;let r=t[0];return{ttfb:r.responseStart-r.requestStart,domContentLoaded:r.domContentLoadedEventEnd-r.startTime,load:r.loadEventEnd-r.startTime,transferSize:r.transferSize??0,encodedBodySize:r.encodedBodySize??0}}catch{return null}}collectConnection(){try{let t=navigator.connection;return t?{effectiveType:t.effectiveType,downlink:t.downlink,rtt:t.rtt}:null}catch{return null}}collectMemory(){try{let r=performance.memory;return r?{usedJSHeapSize:r.usedJSHeapSize,totalJSHeapSize:r.totalJSHeapSize,jsHeapSizeLimit:r.jsHeapSizeLimit}:null}catch{return null}}sendHeartbeat(){let t=this.ctx.auth;if(!t.scopeClientId||!t.organizationId)return;let r=navigator.userAgent,n={scopeClientId:t.scopeClientId,organizationId:t.organizationId,pageUrl:window.location.href,metrics:{navigation:this.collectNavigation(),vitals:{lcp:this.lcpValue,cls:this.clsValue>0?Math.round(this.clsValue*1e3)/1e3:null,inp:this.computeInp()},errors:{jsErrors:te(),consoleErrors:this.consoleErrorCount,consoleWarns:this.consoleWarnCount,resourceFailures:this.resourceFailureCount},connection:this.collectConnection(),memory:this.collectMemory()},metadata:{browser:H(r),browserVersion:V(r),os:N(r),viewport:{width:window.innerWidth,height:window.innerHeight},env:this.ctx.config.env},timestamp:Date.now()};this.ctx.bridge.sendHeartbeat(n)}};z(new Q);var Z="scope-disabled-",Tt=1440*60*1e3;function Mt(e){try{let t=localStorage.getItem(`${Z}${e}`);if(!t)return!1;let r=parseInt(t,10);return Date.now()<r?!0:(localStorage.removeItem(`${Z}${e}`),!1)}catch{return!1}}function Ht(e){try{localStorage.setItem(`${Z}${e}`,String(Date.now()+Tt))}catch{}}var B=class{constructor(t){this.activeModules=[];this.config=t,this.bridge=new O(t.apiUrl,t.token),this.init()}async init(){let t=await this.bridge.waitForAuth();if(!t.authenticated){Ht(this.config.token),this.bridge.destroy();return}this.createHost(),this.initModules(t)}createHost(){this.host=document.createElement("div"),this.host.id="scope-widget",this.shadow=this.host.attachShadow({mode:"closed"});let t=document.createElement("style");t.textContent=ne,this.shadow.appendChild(t),document.body.appendChild(this.host)}initModules(t){let r={config:this.config,auth:t,bridge:this.bridge,host:this.host,shadow:this.shadow};for(let n of se())try{n.init(r),this.activeModules.push(n)}catch(o){console.warn(`[Scope] Module "${n.id}" failed to init:`,o)}}destroy(){for(let t of this.activeModules)try{t.destroy?.()}catch{}this.activeModules=[],this.bridge.destroy(),this.host?.remove()}};(function(){let e=document.currentScript;if(!e)return;let t=e.getAttribute("data-key"),r=e.getAttribute("data-project");if(!t&&!r){console.warn("[Scope] Missing data-key attribute on script tag");return}let n=t||r;if(Mt(n))return;ee();let o;try{o=new URL(e.src).origin}catch{console.warn("[Scope] Could not determine API URL from script src");return}let s=e.getAttribute("data-env")||void 0;new B({token:n,apiUrl:o,env:s})})();window.ScopeWidget=B;})();
