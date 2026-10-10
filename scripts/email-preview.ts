// Renders every notification email from fixtures to .email-preview/: `pnpm email:preview`.

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";

const OUT = join(process.cwd(), ".email-preview");

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const rows: string[] = [];
  for (const { name, event, series } of EMAIL_FIXTURES) {
    const email = await renderNotificationEmail(event, { ...FIXTURE_CONTEXT, series });
    if (!email) continue;
    await writeFile(join(OUT, `${name}.html`), email.html);
    await writeFile(join(OUT, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
    rows.push(
      `<tr><td><a href="${name}.html">${escape(email.subject)}</a></td><td><a href="${name}.txt">text</a></td><td><code>${event.type}</code></td></tr>`,
    );
  }
  const index = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Vardo email preview</title>
<style>body{font:14px system-ui;margin:32px;max-width:900px}td{padding:6px 12px 6px 0}code{color:#71717a}</style>
<h1>Vardo notification emails</h1><table>${rows.join("")}</table>`;
  await writeFile(join(OUT, "index.html"), index);
  console.log(`Wrote ${rows.length} emails to ${OUT}/index.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
