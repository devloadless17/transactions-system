// Render a Markdown doc to PDF the same way the partner docs were produced:
// Markdown -> HTML via `marked` (GFM) -> print to PDF via headless Chromium
// (Playwright's bundled browser). No project dependency on `marked` — it's run
// transiently through `npx`.
//
//   node scripts/md-to-pdf.mjs docs/rival-ingest-api-integration.md [more.md ...]
//
// Each input X.md is written next to it as X.pdf.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from '@playwright/test';

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('usage: node scripts/md-to-pdf.mjs <file.md> [file2.md ...]');
  process.exit(1);
}

// GitHub-flavoured print styling. `pre`/`code` wrap so long lines (API keys,
// JSON, cURL) never clip at the page edge; tables/code avoid mid-element breaks.
const CSS = `
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.55; color: #1f2328; margin: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; font-weight: 600; }
  h1 { font-size: 21pt; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; }
  h2 { font-size: 15pt; padding-bottom: .3em; border-bottom: 1px solid #d0d7de; margin-top: 1.4em; }
  h3 { font-size: 12.5pt; }
  h4 { font-size: 11pt; }
  p, li { font-size: 10.5pt; }
  a { color: #0969da; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.6em 0; }
  blockquote {
    margin: 1em 0; padding: .2em 1em; color: #57606a;
    border-left: .25em solid #d0d7de;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 85%; background: #eff1f3; border-radius: 6px; padding: .15em .4em;
  }
  pre {
    background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px;
    padding: 12px 14px; overflow: visible; page-break-inside: avoid;
    white-space: pre-wrap; word-break: break-word;
  }
  pre code { background: none; padding: 0; font-size: 9pt; line-height: 1.45; }
  table {
    border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 9.3pt;
    page-break-inside: avoid;
  }
  th, td { border: 1px solid #d0d7de; padding: 6px 11px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  tr:nth-child(2n) td { background: #f6f8fa; }
  h1, h2, h3, h4 { page-break-after: avoid; }
  img { max-width: 100%; }
`;

async function render(browser, mdPath) {
  const html = execFileSync('npx', ['-y', 'marked@12', '--gfm', '-i', mdPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const title = basename(mdPath).replace(/\.md$/, '');
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${html}</body></html>`;

  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: 'networkidle' });
  const out = mdPath.replace(/\.md$/, '.pdf');
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false,
    margin: { top: '16mm', bottom: '16mm', left: '15mm', right: '15mm' },
  });
  await page.close();
  // Surface the source content size so the caller can sanity-check it's non-empty.
  console.log(`✓ ${out}  (${readFileSync(mdPath, 'utf8').length} md chars -> pdf)`);
}

const browser = await chromium.launch();
try {
  for (const md of inputs) await render(browser, md);
} finally {
  await browser.close();
}
