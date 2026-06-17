// ============================================================
// import.js — .docx → HTML conversion using mammoth.
//
// All work is browser-side. Mammoth ships a browser bundle that exposes
// `convertToHtml({arrayBuffer})` and a `messages` array describing things
// it stripped (footnotes, comments, tracked changes, etc).
// ============================================================

import { sanitizeHtml } from './format.js';

let _mammothLib = null;

/**
 * Lazy-load the mammoth browser bundle. Only fetched when the user actually
 * imports a .docx — keeps cold-start small.
 */
async function loadMammoth() {
  if (_mammothLib) return _mammothLib;
  // mammoth.js ships a UMD browser bundle; esm.sh wraps it as ESM.
  // The default export is the mammoth object.
  const mod = await import('https://esm.sh/mammoth@1.8.0?bundle');
  _mammothLib = mod.default || mod;
  return _mammothLib;
}

/**
 * Convert a .docx Blob (or File) into sanitized HTML.
 * Returns an object with the HTML and any conversion messages.
 *
 * @param {Blob|File} blob
 * @returns {Promise<{html: string, messages: Array<{type:string,message:string}>}>}
 */
export async function docxBlobToHtml(blob) {
  const mammoth = await loadMammoth();
  const arrayBuffer = await blob.arrayBuffer();

  // Map common Word styles to our editor-friendly tags.
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h2:fresh",
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Quote'] => blockquote:fresh",
        "p[style-name='Intense Quote'] => blockquote:fresh",
        "b => strong",
        "i => em",
      ],
      ignoreEmptyParagraphs: false,
    }
  );

  // mammoth returns a list of messages we can show the user — they tell us
  // what was lost (footnotes, comments, embedded equations, etc).
  const html = sanitizeHtml(result.value || '');
  const messages = (result.messages || []).map(m => ({
    type: m.type || 'info',
    message: m.message || String(m),
  }));
  return { html, messages };
}

/**
 * Split sanitized HTML into chapters by H1 headings.
 * Each H1 starts a new chapter; the H1's text becomes the chapter title.
 * Content before the first H1 is dropped (assumed to be title page / TOC).
 * If there are no H1s, returns a single chapter using `fallbackTitle`.
 *
 * @param {string} html
 * @param {string} fallbackTitle  used when no H1 is found
 * @returns {Array<{title: string, html: string}>}
 */
export function splitHtmlByH1(html, fallbackTitle = 'Imported chapter') {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';

  const chapters = [];
  let current = null;

  for (const node of tpl.content.childNodes) {
    if (node.nodeType !== 1) continue;
    if (node.tagName === 'H1') {
      if (current) chapters.push(current);
      current = {
        title: (node.textContent || 'Untitled').trim() || 'Untitled',
        html: '',
      };
    } else if (current) {
      current.html += node.outerHTML;
    }
    // Pre-H1 content is intentionally dropped (cover page noise).
  }
  if (current) chapters.push(current);

  if (!chapters.length) {
    return [{ title: fallbackTitle, html: html || '<p><br></p>' }];
  }
  // Empty chapters get a blank paragraph so the editor caret lands somewhere.
  return chapters.map(c => ({
    title: c.title,
    html: c.html.trim() || '<p><br></p>',
  }));
}
