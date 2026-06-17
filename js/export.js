// ============================================================
// export.js — Manual exports + the .docx generator used by
// the publish flow and the optional Drive book.docx mirror.
//
// Library: docx (https://github.com/dolanmiu/docx) loaded as ESM from esm.sh.
// All work is browser-side; no server.
// ============================================================

import { isoForFilename, escapeHtml } from './utils.js';

let _docxLib = null;

/**
 * Lazy-load the docx library only when an export is requested.
 * Cuts cold-start cost for users who never export.
 */
async function loadDocx() {
  if (_docxLib) return _docxLib;
  _docxLib = await import('https://esm.sh/docx@9');
  return _docxLib;
}

// ============ HTML → docx PARAGRAPHS ============

/** Map a CSS text-align value to a docx AlignmentType, or null if none. */
function pickAlignment(node, D) {
  const align = (node.style?.textAlign || '').toLowerCase();
  if (align === 'center')  return D.AlignmentType.CENTER;
  if (align === 'right')   return D.AlignmentType.RIGHT;
  if (align === 'justify') return D.AlignmentType.JUSTIFIED;
  if (align === 'left')    return D.AlignmentType.LEFT;
  return null;
}

/** Convert a base64 data: URL to a Uint8Array (for ImageRun). null on failure. */
function dataUrlToBytes(dataUrl) {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Build a docx ImageRun for an <img> element, or null if unsupported. */
function imageRunFor(imgEl, D) {
  const src = imgEl.getAttribute('src') || '';
  if (src.startsWith('data:')) {
    const bytes = dataUrlToBytes(src);
    if (!bytes) return null;
    // Constrain on-page width — actual aspect ratio preserved on Word's side
    // since we don't have natural dimensions in a static parse.
    const width = parseInt(imgEl.getAttribute('width'), 10) || 480;
    const height = parseInt(imgEl.getAttribute('height'), 10) || Math.round(width * 0.66);
    return new D.ImageRun({
      data: bytes,
      transformation: { width, height },
    });
  }
  // External http(s) image — docx-js can't fetch in browser without CORS, so
  // we drop with a plain-text fallback so the chapter still flows.
  return null;
}

/** Recursively flatten a list (UL/OL) into Paragraphs with bullet/number formatting. */
function flattenList(listEl, D, depth = 0) {
  const { Paragraph, TextRun } = D;
  const ordered = listEl.tagName === 'OL';
  const out = [];
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    // Build a paragraph from any non-list children of this <li>; nested lists recurse.
    const inlineRuns = [];
    const trailing = [];
    for (const child of li.childNodes) {
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
        trailing.push(...flattenList(child, D, depth + 1));
      } else {
        const runs = childToRuns(child, D, {});
        inlineRuns.push(...runs);
      }
    }
    if (!inlineRuns.length) inlineRuns.push(new TextRun(''));
    out.push(new Paragraph({
      children: inlineRuns,
      bullet: ordered ? undefined : { level: depth },
      numbering: ordered ? { reference: 'bookapp-numbered', level: depth } : undefined,
      indent: { left: 720 + depth * 360 },
    }));
    out.push(...trailing);
  }
  return out;
}

/** Build a docx Table from a <table> element. */
function tableFromHtml(tableEl, D) {
  const { Table, TableRow, TableCell, Paragraph, WidthType } = D;
  const rows = [];
  // Collect every TR regardless of whether it's in THEAD/TBODY.
  const trs = tableEl.querySelectorAll('tr');
  for (const tr of trs) {
    const cells = [];
    for (const td of tr.children) {
      if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
      const cellChildren = htmlBlocksToDocxParagraphs(td.innerHTML, D);
      cells.push(new TableCell({
        children: cellChildren.length ? cellChildren : [new Paragraph('')],
        columnSpan: parseInt(td.getAttribute('colspan'), 10) || 1,
        rowSpan: parseInt(td.getAttribute('rowspan'), 10) || 1,
      }));
    }
    if (cells.length) rows.push(new TableRow({ children: cells }));
  }
  if (!rows.length) return null;
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/** Walk a child node and return an array of docx TextRuns / images / link runs. */
function childToRuns(node, D, fmt) {
  const { TextRun, ExternalHyperlink } = D;
  const out = [];
  if (node.nodeType === 3) {
    if (node.nodeValue) out.push(new TextRun({ text: node.nodeValue, ...fmt }));
    return out;
  }
  if (node.nodeType !== 1) return out;
  const t = node.tagName;
  if (t === 'BR') { out.push(new TextRun({ text: '', break: 1 })); return out; }
  if (t === 'IMG') {
    const img = imageRunFor(node, D);
    if (img) out.push(img);
    else if (node.getAttribute('alt')) out.push(new TextRun({ text: `[image: ${node.getAttribute('alt')}]`, italics: true, ...fmt }));
    return out;
  }
  if (t === 'A') {
    const href = node.getAttribute('href') || '';
    const innerRuns = [];
    for (const c of node.childNodes) innerRuns.push(...childToRuns(c, D, fmt));
    out.push(new ExternalHyperlink({ link: href, children: innerRuns.length ? innerRuns : [new TextRun({ text: node.textContent, ...fmt })] }));
    return out;
  }
  const next = { ...fmt };
  if (t === 'STRONG' || t === 'B') next.bold = true;
  if (t === 'EM' || t === 'I') next.italics = true;
  if (t === 'U') next.underline = {};
  if (t === 'S' || t === 'STRIKE') next.strike = true;
  for (const c of node.childNodes) out.push(...childToRuns(c, D, next));
  return out;
}

/**
 * Convert sanitized chapter HTML into an array of docx block-level items
 * (Paragraphs and Tables). Handles the full Phase 4 allow-list:
 * P, H1, H2, H3, BLOCKQUOTE, UL/OL/LI, TABLE, FIGURE, IMG (as block when standalone).
 */
function htmlBlocksToDocxParagraphs(html, D) {
  const { Paragraph, TextRun, HeadingLevel } = D;

  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const out = [];

  for (const node of tpl.content.childNodes) {
    if (node.nodeType !== 1) continue;
    const tag = node.tagName;

    if (tag === 'P' && node.classList.contains('scene-break')) {
      out.push(new Paragraph({
        alignment: D.AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
        children: [new TextRun('* * *')],
      }));
      continue;
    }

    if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
      const level = tag === 'H1' ? HeadingLevel.HEADING_1
                  : tag === 'H2' ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3;
      out.push(new Paragraph({
        heading: level,
        alignment: pickAlignment(node, D) || undefined,
        children: childrenToRuns(node, D),
      }));
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      out.push(new Paragraph({
        style: 'Quote',
        indent: { left: 720 },
        alignment: pickAlignment(node, D) || undefined,
        children: childrenToRuns(node, D),
      }));
      continue;
    }

    if (tag === 'UL' || tag === 'OL') {
      out.push(...flattenList(node, D, 0));
      continue;
    }

    if (tag === 'TABLE') {
      const t = tableFromHtml(node, D);
      if (t) {
        out.push(t);
        // Drop a tiny spacer paragraph after the table (docx requires).
        out.push(new Paragraph({ children: [new TextRun('')] }));
      }
      continue;
    }

    if (tag === 'FIGURE') {
      // figcaption + img — emit the image plus an italic caption Paragraph.
      const img = node.querySelector('img');
      if (img) {
        const ir = imageRunFor(img, D);
        if (ir) out.push(new Paragraph({ alignment: D.AlignmentType.CENTER, children: [ir] }));
      }
      const cap = node.querySelector('figcaption');
      if (cap?.textContent) {
        out.push(new Paragraph({
          alignment: D.AlignmentType.CENTER,
          children: [new TextRun({ text: cap.textContent, italics: true, size: 18 })],
        }));
      }
      continue;
    }

    if (tag === 'IMG') {
      const ir = imageRunFor(node, D);
      if (ir) out.push(new Paragraph({ alignment: D.AlignmentType.CENTER, children: [ir] }));
      continue;
    }

    // P, DIV, anything else block-ish — treat as a paragraph.
    out.push(new Paragraph({
      alignment: pickAlignment(node, D) || undefined,
      children: childrenToRuns(node, D),
    }));
  }

  if (!out.length) out.push(new Paragraph({ children: [new TextRun('')] }));
  return out;
}

/** Walk an element's children and emit runs/images/links honoring nested marks. */
function childrenToRuns(el, D) {
  const runs = [];
  for (const child of el.childNodes) runs.push(...childToRuns(child, D, {}));
  if (!runs.length) runs.push(new D.TextRun(''));
  return runs;
}

// ============ TOP-LEVEL DOCUMENT BUILDERS ============

/**
 * Build a docx Blob for a whole book.
 *
 * @param {object} doc                       state.doc
 * @param {object} [opts]
 * @param {boolean} [opts.includeTitlePage]  default true
 * @param {boolean} [opts.includeTOC]        default true
 * @returns {Promise<Blob>}
 */
export async function htmlToDocxBlob(doc, opts = {}) {
  const D = await loadDocx();
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak,
    TableOfContents, StyleLevel,
  } = D;

  const includeTitlePage = opts.includeTitlePage !== false;
  const includeTOC = opts.includeTOC !== false;

  const sections = [];

  // --- Title page ---
  if (includeTitlePage) {
    sections.push({
      properties: {},
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 2400 },
          children: [new TextRun({ text: doc.title || 'Untitled Book', bold: true, size: 56 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480 },
          children: [new TextRun({ text: new Date().toLocaleDateString(), size: 22 })],
        }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    });
  }

  // --- TOC ---
  if (includeTOC) {
    sections.push({
      properties: {},
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          children: [new TextRun('Contents')],
        }),
        // TOC populates on Word's "Update field" — that's expected behavior.
        new TableOfContents('Contents', {
          hyperlink: true,
          headingStyleRange: '1-2',
        }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    });
  }

  // --- Chapters ---
  for (let i = 0; i < doc.chapters.length; i++) {
    const ch = doc.chapters[i];
    const isLast = i === doc.chapters.length - 1;

    const children = [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 480, after: 480 },
        children: [new TextRun({ text: ch.title || `Chapter ${i + 1}`, bold: true })],
      }),
      ...htmlBlocksToDocxParagraphs(ch.html || '', D),
    ];
    if (!isLast) children.push(new Paragraph({ children: [new PageBreak()] }));

    sections.push({ properties: {}, children });
  }

  // --- Document with sane defaults ---
  const document = new Document({
    creator: 'BookApp',
    title: doc.title || 'Untitled Book',
    styles: {
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { italics: true, color: '666666' },
          paragraph: { indent: { left: 720, right: 720 }, spacing: { before: 240, after: 240 } },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bookapp-numbered',
          levels: [
            { level: 0, format: 'decimal',     text: '%1.', alignment: D.AlignmentType.START },
            { level: 1, format: 'lowerLetter', text: '%2.', alignment: D.AlignmentType.START },
            { level: 2, format: 'lowerRoman',  text: '%3.', alignment: D.AlignmentType.START },
          ],
        },
      ],
    },
    sections,
  });

  return Packer.toBlob(document);
}

/** Build a docx for a single chapter (used by per-chapter export). */
export async function chapterToDocxBlob(chapter, bookTitle) {
  return htmlToDocxBlob(
    { title: bookTitle || chapter.title || 'Chapter', chapters: [chapter] },
    { includeTitlePage: false, includeTOC: false }
  );
}

// ============ DOWNLOAD HELPERS ============

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Slug-safe filename component. */
export function slugify(s, max = 60) {
  return String(s || 'book')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'book';
}

// ============ EXPORT ACTIONS (called by toolbar / menu) ============

/** Export the entire book as .docx (downloaded). */
export async function exportBookDocx(doc) {
  const blob = await htmlToDocxBlob(doc);
  downloadBlob(blob, `${slugify(doc.title)}-${isoForFilename()}.docx`);
}

/** Export the active chapter as .docx (downloaded). */
export async function exportChapterDocx(chapter, bookTitle) {
  const blob = await chapterToDocxBlob(chapter, bookTitle);
  downloadBlob(blob, `${slugify(chapter.title || 'chapter')}-${isoForFilename()}.docx`);
}

/** Export the book as a JSON backup file (downloaded). */
export function exportBookJson(doc) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${slugify(doc.title)}-${isoForFilename()}.json`);
}

/**
 * Open a print-styled window with all chapters and call window.print().
 * Cleaner than fighting the SPA's CSS for print fidelity.
 */
export function printBook(doc) {
  const win = window.open('', '_blank', 'width=900,height=1100');
  if (!win) {
    alert('Could not open print window — disable popup blockers and try again.');
    return;
  }
  const chaptersHtml = (doc.chapters || []).map((ch, i) => `
    <section class="chapter">
      <h1>${escapeHtml(ch.title || `Chapter ${i + 1}`)}</h1>
      ${ch.html || ''}
    </section>
  `).join('');

  win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(doc.title || 'Book')}</title>
<style>
  @page { size: 6in 9in; margin: 0.85in 0.7in; }
  html, body { background: #fff; color: #1a1a1a; }
  body { font-family: 'Iowan Old Style','Hoefler Text','Cambria','Georgia',serif;
         font-size: 11.5pt; line-height: 1.55; text-align: justify; hyphens: auto;
         max-width: 6in; margin: 0 auto; padding: 0.5in 0; }
  .title-page { text-align: center; page-break-after: always; padding-top: 3in; }
  .title-page h1 { font-size: 28pt; margin-bottom: 0.5in; }
  .chapter { page-break-before: always; }
  .chapter:first-of-type { page-break-before: avoid; }
  .chapter h1 { text-align: center; font-size: 20pt; margin: 1.2in 0 0.5in; page-break-after: avoid; }
  h2 { font-size: 14pt; margin: 0.4in 0 0.15in; page-break-after: avoid; }
  p { margin: 0; text-indent: 1.2em; }
  p:first-of-type, h1 + p, h2 + p, blockquote + p { text-indent: 0; }
  blockquote { margin: 0.2in 0.4in; font-style: italic; color: #555; }
  .scene-break { text-align: center; text-indent: 0; margin: 0.25in 0; letter-spacing: 0.4em; }
  .scene-break::before { content: '* * *'; }
  @media print { body { padding: 0; } }
</style>
</head><body>
  <section class="title-page"><h1>${escapeHtml(doc.title || 'Untitled Book')}</h1>
    <div>${escapeHtml(new Date().toLocaleDateString())}</div></section>
  ${chaptersHtml}
  <script>setTimeout(() => window.print(), 200);<\/script>
</body></html>`);
  win.document.close();
}
