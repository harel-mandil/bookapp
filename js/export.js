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

/**
 * Convert sanitized chapter HTML into an array of docx Paragraph objects.
 * Handles the Phase 2 allow-list: P, H1, H2, BLOCKQUOTE, STRONG/B, EM/I, BR.
 * Phase 4 will extend this to lists, tables, images, alignment.
 */
function htmlBlocksToDocxParagraphs(html, D) {
  const { Paragraph, TextRun, HeadingLevel, AlignmentType } = D;

  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const out = [];

  for (const node of tpl.content.childNodes) {
    if (node.nodeType !== 1) continue;          // skip text/comment at root
    const tag = node.tagName;

    if (tag === 'P' && node.classList.contains('scene-break')) {
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
        children: [new TextRun('* * *')],
      }));
      continue;
    }

    if (tag === 'H1') {
      out.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: collectRuns(node, D),
      }));
    } else if (tag === 'H2') {
      out.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: collectRuns(node, D),
      }));
    } else if (tag === 'BLOCKQUOTE') {
      out.push(new Paragraph({
        style: 'Quote',
        indent: { left: 720 },                  // ½"
        children: collectRuns(node, D),
      }));
    } else if (tag === 'P' || tag === 'DIV') {
      out.push(new Paragraph({ children: collectRuns(node, D) }));
    } else {
      // Unknown block — fall through as a plain paragraph.
      out.push(new Paragraph({ children: collectRuns(node, D) }));
    }
  }

  // docx requires at least one paragraph per section.
  if (!out.length) out.push(new Paragraph({ children: [new TextRun('')] }));
  return out;
}

/** Walk an element's children and emit TextRuns honoring nested <strong>/<em>. */
function collectRuns(el, D) {
  const { TextRun } = D;
  const runs = [];

  function walk(node, fmt) {
    if (node.nodeType === 3) {                  // text
      const text = node.nodeValue;
      if (text) runs.push(new TextRun({ text, ...fmt }));
      return;
    }
    if (node.nodeType !== 1) return;
    const t = node.tagName;
    if (t === 'BR') {
      runs.push(new TextRun({ text: '', break: 1 }));
      return;
    }
    const next = { ...fmt };
    if (t === 'STRONG' || t === 'B') next.bold = true;
    if (t === 'EM' || t === 'I') next.italics = true;
    if (t === 'U') next.underline = {};
    if (t === 'S' || t === 'STRIKE') next.strike = true;
    for (const child of node.childNodes) walk(child, next);
  }

  for (const child of el.childNodes) walk(child, {});
  if (!runs.length) runs.push(new TextRun(''));
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
