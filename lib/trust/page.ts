// The public trust page as one self-contained HTML document: inline styles, no scripts, no third-party requests.
// It shares a host with the operator's app, so it can't rely on /_next assets.

import { checkedAgo, type PublicTrust } from "./public";

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Blank-line paragraphs, "- " bullets and "## " headings. Everything is escaped. */
export function renderBody(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trimEnd());
      if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>`;
      if (lines.length === 1 && lines[0].startsWith("## ")) return `<h4>${esc(lines[0].slice(3))}</h4>`;
      return `<p>${lines.map(esc).join("<br>")}</p>`;
    })
    .join("");
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const CSS = `
:root{--background:oklch(95.8% .005 85);--foreground:oklch(18% .012 75);--card:oklch(99.3% .001 85);--primary:oklch(20% .012 75);--primary-foreground:oklch(98.5% .003 85);--muted:oklch(96.4% .005 83);--muted-foreground:oklch(44% .013 78);--border:oklch(89.5% .007 82);--brass:oklch(48% .098 72);--success:oklch(45% .106 155);--shadow:0 1px 2px rgba(28,22,14,.05),0 2px 8px rgba(28,22,14,.04);--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--background:oklch(16% .008 75);--foreground:oklch(93% .006 85);--card:oklch(24.5% .009 75);--primary:oklch(93% .004 85);--primary-foreground:oklch(16% .008 75);--muted:oklch(28% .008 75);--muted-foreground:oklch(68% .012 80);--border:oklch(100% .006 85 / 9%);--brass:oklch(74% .085 82);--success:oklch(70% .12 155);--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--background);color:var(--foreground);font:400 15px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 32px}
.top{border-bottom:1px solid var(--border)}
.top .wrap{display:flex;align-items:center;gap:10px;height:60px}
.mark{width:28px;height:28px;border-radius:8px;background:var(--primary);color:var(--primary-foreground);display:grid;place-items:center;font:700 12px/1 var(--font-sans);flex:none}
.op{font-weight:700;font-size:17px;letter-spacing:-.02em}
.sep{width:1px;height:18px;background:var(--border)}
.sub{color:var(--muted-foreground);font-size:14px}
.hero{padding:56px 0 8px}
.label{font:500 13px/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--brass)}
h1{font-size:clamp(32px,5vw,46px);line-height:1.08;letter-spacing:-.03em;margin:14px 0;max-width:20ch}
.lede{font-size:17px;color:var(--muted-foreground);max-width:60ch;margin:0}
section{padding-top:48px}
h2{font-size:22px;line-height:1.25;letter-spacing:-.015em;margin:0 0 6px}
.note{color:var(--muted-foreground);font-size:14px;margin:0 0 16px}
.card{background:var(--card);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}
.pad{padding:20px 22px}
.hosting{display:grid;gap:4px}
.hosting b{font-size:18px}
.hosting .sub a{text-underline-offset:3px}
table{width:100%;border-collapse:collapse;font-size:14.5px}
th{font:500 12px/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);text-align:left;padding:16px 22px 10px}
td{padding:13px 22px;border-top:1px solid var(--border);vertical-align:top}
td:first-child{font-weight:600}
td.m{color:var(--muted-foreground)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(3,1fr)}
@media (max-width:980px){.grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:640px){.grid{grid-template-columns:1fr}.wrap{padding:0 16px}}
.ctl{padding:18px 20px 8px}
.ctl h3{font-size:16px;margin:0 0 6px}
ul.rows{list-style:none;margin:0;padding:0}
ul.rows li{display:grid;grid-template-columns:16px 1fr;gap:10px;padding:9px 0;border-top:1px solid var(--border)}
ul.rows li:first-child{border-top:0}
ul.rows svg{width:12px;height:12px;margin-top:6px;color:var(--success)}
.when{display:block;color:var(--muted-foreground);font:400 12.5px/1.3 var(--font-mono);margin-top:2px}
.docs{display:grid;gap:10px}
details.doc{background:var(--card);border-radius:16px;box-shadow:var(--shadow)}
details.doc summary{cursor:pointer;padding:14px 18px;font-weight:600;display:flex;justify-content:space-between;gap:12px;list-style:none}
details.doc summary::-webkit-details-marker{display:none}
details.doc summary span{font-weight:400;color:var(--muted-foreground);font-size:13px}
.doc-body{padding:0 18px 16px;border-top:1px solid var(--border);font-size:14.5px}
.doc-body h4{margin:16px 0 4px;font-size:14px}
.doc-body p,.doc-body ul{margin:8px 0}
a.file{display:flex;justify-content:space-between;gap:12px;padding:14px 18px;border-radius:16px;background:var(--card);box-shadow:var(--shadow);text-decoration:none;font-weight:600}
a.file span{font-weight:400;color:var(--muted-foreground);font-size:13px}
footer{padding:48px 0 56px;display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;color:var(--muted-foreground);font-size:13px}
footer a{text-decoration:none}footer a:hover{text-decoration:underline;text-underline-offset:4px}
`;

const DOT = `<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3" fill="currentColor"/></svg>`;

function sectionHtml(id: string, title: string, note: string | null, body: string): string {
  return `<section id="${id}"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ""}${body}</section>`;
}

export function renderTrustPage(t: PublicTrust, now: Date): string {
  const parts: string[] = [];

  if (t.hosting) {
    const where = [t.hosting.provider, t.hosting.location].filter(Boolean).join(", ");
    const cert = t.hosting.certification
      ? `<div class="sub">Hosted on infrastructure certified to ${esc(t.hosting.certification.standard)}. <a href="${esc(t.hosting.certification.url)}" rel="noopener noreferrer" target="_blank">View the provider&rsquo;s certificate</a></div>`
      : "";
    parts.push(sectionHtml("hosting", "Hosting", null, `<div class="card pad hosting"><b>${esc(where)}</b>${cert}</div>`));
  }

  if (t.commitments.length) {
    const rows = t.commitments.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(c.value)}</td></tr>`).join("");
    parts.push(sectionHtml("commitments", "Commitments", null, `<div class="card"><table><thead><tr><th>Commitment</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }

  if (t.policies.length || t.dpa) {
    const policies = t.policies.map(
      (p) =>
        `<details class="doc" id="${esc(p.id)}"><summary>${esc(p.title)}<span>Reviewed ${dateFmt.format(p.reviewedAt)}</span></summary><div class="doc-body">${renderBody(p.body)}</div></details>`,
    );
    const dpa = t.dpa ? [`<a class="file" href="/trust/dpa.pdf">Data processing agreement<span>PDF</span></a>`] : [];
    parts.push(sectionHtml("documents", "Documents", null, `<div class="docs">${[...policies, ...dpa].join("")}</div>`));
  }

  if (t.controls.length) {
    const cards = t.controls
      .map(
        (g) =>
          `<div class="card ctl"><h3>${esc(g.group)}</h3><ul class="rows">${g.items
            .map((i) => `<li>${DOT}<span>${esc(i.outcome)}<span class="when">${esc(checkedAgo(i.checkedAt, now))}</span></span></li>`)
            .join("")}</ul></div>`,
      )
      .join("");
    parts.push(sectionHtml("controls", "Controls", "Measured from the live system.", `<div class="grid">${cards}</div>`));
  }

  if (t.subprocessors.length) {
    const rows = t.subprocessors
      .map((s) => `<tr><td>${esc(s.name)}</td><td class="m">${esc(s.purpose)}</td><td class="m">${esc(s.region ?? "")}</td></tr>`)
      .join("");
    parts.push(
      sectionHtml(
        "subprocessors",
        "Subprocessors",
        `Services that can handle client data on behalf of ${t.name}.`,
        `<div class="card"><table><thead><tr><th>Provider</th><th>Purpose</th><th>Region</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      ),
    );
  }

  const contact = t.securityContact ? `<a href="mailto:${esc(t.securityContact)}">${esc(t.securityContact)}</a>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Trust center · ${esc(t.name)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="mark" aria-hidden="true">${esc(initials(t.name))}</span><span class="op">${esc(t.name)}</span><span class="sep"></span><span class="sub">Trust center</span></div></header>
<main class="wrap">
<div class="hero">
<div class="label">Trust center</div>
<h1>How ${esc(t.name)} protects client data</h1>
<p class="lede">Where client sites are hosted, how they&rsquo;re backed up and secured, and who else handles the data.</p>
</div>
${parts.join("\n")}
<footer><span>Generated by Vardo</span>${contact ? `<span>Report a security problem: ${contact}</span>` : ""}</footer>
</main>
</body>
</html>`;
}
