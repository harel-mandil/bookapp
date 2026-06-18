// ============================================================
// epub.js — EPUB 3 export.
//
// Builds a minimal EPUB 3 zip:
//   mimetype                          (stored, no compression)
//   META-INF/container.xml            (points to OPF)
//   OEBPS/content.opf                 (manifest + spine)
//   OEBPS/nav.xhtml                   (TOC)
//   OEBPS/styles.css                  (book CSS)
//   OEBPS/cover.xhtml                 (title page)
//   OEBPS/chapter-N.xhtml             (one per chapter)
//
// Lazily loads jszip from esm.sh.
// ============================================================

import { downloadBlob, slugify } from './export.js';
import { isoForFilename, escapeHtml } from './utils.js';
import { sanitizeHtml } from './sanitize.js';

let _JSZip = null;
async function loadZip() {
  if (_JSZip) return _JSZip;
  const mod = await import('https://esm.sh/jszip@3.10.1');
  _JSZip = mod.default || mod;
  return _JSZip;
}

const EPUB_CSS = `
body { font-family: serif; line-height: 1.55; }
h1 { text-align: center; font-size: 1.6em; margin: 2em 0 1em; }
h2 { text-align: center; font-size: 1.2em; margin: 1.2em 0 0.6em; font-variant: small-caps; letter-spacing: 0.08em; }
p  { margin: 0; text-indent: 1.4em; }
h1 + p, h2 + p, blockquote + p, p:first-of-type { text-indent: 0; }
blockquote { margin: 1em 1.6em; font-style: italic; color: #555; }
.scene-break { text-align: center; text-indent: 0; margin: 1em 0; letter-spacing: 0.4em; color: #888; }
.scene-break::before { content: '* * *'; }
img { max-width: 100%; height: auto; }
`;

function uuidLike() {
  // Time-based pseudo UUID (no Date.now ban here — runs in browser).
  return 'urn:bookapp:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function chapterXhtml(title, htmlBody) {
  // EPUB requires XHTML — sanitizer already produces well-formed-ish output;
  // we wrap it.
  const safe = sanitizeHtml(htmlBody || '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${safe}
</body></html>`;
}

function coverXhtml(bookTitle) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeHtml(bookTitle)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body style="text-align:center;padding-top:30%;">
  <h1 style="font-size:2em;">${escapeHtml(bookTitle)}</h1>
  <p style="text-indent:0;color:#666;">${escapeHtml(new Date().toLocaleDateString())}</p>
</body></html>`;
}

function navXhtml(bookTitle, chapters) {
  const items = chapters.map((c, i) => `<li><a href="chapter-${i + 1}.xhtml">${escapeHtml(c.title || `Chapter ${i + 1}`)}</a></li>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>${items}</ol>
  </nav>
</body></html>`;
}

function contentOpf(book, chapters, uid) {
  const manifest = chapters.map((c, i) =>
    `<item id="chap${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
  ).join('\n  ');
  const spine = chapters.map((c, i) => `<itemref idref="chap${i + 1}"/>`).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">${uid}</dc:identifier>
  <dc:title>${escapeHtml(book.title || 'Untitled Book')}</dc:title>
  <dc:language>en</dc:language>
  <dc:creator>BookApp</dc:creator>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
  <item id="nav"  href="nav.xhtml"   media-type="application/xhtml+xml" properties="nav"/>
  <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
  <item id="css"  href="styles.css"  media-type="text/css"/>
  ${manifest}
</manifest>
<spine>
  <itemref idref="cover"/>
  <itemref idref="nav"/>
  ${spine}
</spine>
</package>`;
}

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

export async function exportBookEpub(doc) {
  const JSZip = await loadZip();
  const zip = new JSZip();

  // mimetype must be the FIRST entry, stored (no compression).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.folder('META-INF').file('container.xml', CONTAINER_XML);

  const oebps = zip.folder('OEBPS');
  oebps.file('styles.css', EPUB_CSS);

  const chapters = doc.chapters || [];
  const uid = uuidLike();

  oebps.file('content.opf', contentOpf(doc, chapters, uid));
  oebps.file('cover.xhtml', coverXhtml(doc.title || 'Untitled Book'));
  oebps.file('nav.xhtml', navXhtml(doc.title || 'Untitled Book', chapters));

  chapters.forEach((c, i) => {
    oebps.file(`chapter-${i + 1}.xhtml`, chapterXhtml(c.title || `Chapter ${i + 1}`, c.html || ''));
  });

  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  downloadBlob(blob, `${slugify(doc.title)}-${isoForFilename()}.epub`);
}

// ============ MARKDOWN EXPORT ============

export function exportBookMarkdown(doc) {
  const md = (doc.chapters || []).map((c, i) => {
    const heading = `# ${c.title || `Chapter ${i + 1}`}\n\n`;
    return heading + htmlToMarkdown(c.html || '');
  }).join('\n\n---\n\n');
  const blob = new Blob([`# ${doc.title || 'Untitled Book'}\n\n${md}\n`], { type: 'text/markdown' });
  downloadBlob(blob, `${slugify(doc.title)}-${isoForFilename()}.md`);
}

function htmlToMarkdown(html) {
  // Light-touch converter — prioritizes readability, not a Pandoc replacement.
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return walkNodes(tpl.content).trim();
}

function walkNodes(node) {
  let out = '';
  for (const c of node.childNodes) out += nodeToMd(c);
  return out;
}

function nodeToMd(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const t = node.tagName;
  const inner = walkNodes(node);
  switch (t) {
    case 'P':          return inner.trim() + '\n\n';
    case 'BR':         return '  \n';
    case 'H1':         return '# '   + inner.trim() + '\n\n';
    case 'H2':         return '## '  + inner.trim() + '\n\n';
    case 'H3':         return '### ' + inner.trim() + '\n\n';
    case 'BLOCKQUOTE': return inner.trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
    case 'STRONG':
    case 'B':          return `**${inner}**`;
    case 'EM':
    case 'I':          return `*${inner}*`;
    case 'U':          return inner;
    case 'S':
    case 'STRIKE':     return `~~${inner}~~`;
    case 'A':          return `[${inner}](${node.getAttribute('href') || ''})`;
    case 'IMG':        return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
    case 'UL':
    case 'OL': {
      let n = 1;
      let lines = '';
      for (const li of node.children) {
        if (li.tagName !== 'LI') continue;
        const prefix = t === 'OL' ? `${n++}. ` : '- ';
        lines += prefix + walkNodes(li).trim().replace(/\n+/g, ' ') + '\n';
      }
      return lines + '\n';
    }
    case 'HR':         return '\n---\n\n';
    case 'TABLE':      return tableToMd(node) + '\n\n';
    default:           return inner;
  }
}

function tableToMd(table) {
  const rows = [...table.querySelectorAll('tr')].map(tr =>
    [...tr.children].map(td => walkNodes(td).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '))
  );
  if (!rows.length) return '';
  const head = rows[0];
  const sep = head.map(() => '---');
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.slice(1).map(r => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}
