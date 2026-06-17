// ============================================================
// sanitize.js — DOM-based HTML sanitizer with an explicit allow-list.
//
// Used by:
//   - paste / drop into the editor
//   - .docx import (mammoth output)
//   - Drive doc loads / snapshot restores (defense in depth)
//
// Approach: parse via DOMParser (does NOT execute scripts), walk the tree,
// keep tags/attrs that match the allow-list, unwrap unknown elements,
// strip dangerous attributes (style except text-align, on*, src/href that
// aren't http(s)/mailto/data:image).
//
// The TipTap editor produces a fixed set of tags and a fixed set of
// attributes (e.g. text-align inline-style, table colspan/rowspan), so the
// allow-list mirrors that surface — anything else came from elsewhere and
// is suspicious.
// ============================================================

const ALLOWED_BLOCK = new Set([
  'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE',
  'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'FIGURE', 'FIGCAPTION',
]);

const ALLOWED_INLINE = new Set([
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE',
  'BR', 'A', 'IMG', 'CODE', 'SPAN',
]);

// Tags that get fully removed (children dropped — content is hostile/noise).
const STRIP_WITH_CHILDREN = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT',
  'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'CANVAS',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
]);

// Allowed attributes per tag (lowercase). Anything not listed is stripped.
const ALLOWED_ATTRS = {
  A: new Set(['href', 'title', 'rel', 'target']),
  IMG: new Set(['src', 'alt', 'title', 'width', 'height']),
  TH: new Set(['colspan', 'rowspan']),
  TD: new Set(['colspan', 'rowspan']),
  // The TextAlign extension emits style="text-align: …" on these:
  P: new Set(['style']),
  H1: new Set(['style']),
  H2: new Set(['style']),
  H3: new Set(['style']),
  BLOCKQUOTE: new Set(['style']),
};

// Only these style declarations survive. Everything else (color, font, etc.)
// is dropped to keep paste from Word/Docs from polluting the document.
const ALLOWED_STYLE = /^text-align:\s*(left|right|center|justify);?$/i;

const SAFE_HREF = /^(?:https?:|mailto:|#)/i;
const SAFE_IMG_SRC = /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i;

/**
 * Sanitize an HTML string. Returns clean innerHTML.
 */
export function sanitizeHtml(rawHtml) {
  if (!rawHtml) return '';
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  function clean(node) {
    if (node.nodeType === 3) return node;                     // text — keep
    if (node.nodeType !== 1) return null;
    const tag = node.tagName;

    if (STRIP_WITH_CHILDREN.has(tag)) return null;

    if (ALLOWED_BLOCK.has(tag) || ALLOWED_INLINE.has(tag)) {
      const target = document.createElement(tag.toLowerCase());

      // Copy approved attributes only.
      const allowed = ALLOWED_ATTRS[tag];
      if (allowed) {
        for (const attr of [...node.attributes]) {
          const name = attr.name.toLowerCase();
          if (!allowed.has(name)) continue;

          let val = attr.value;
          if (name === 'href') {
            if (!SAFE_HREF.test(val)) continue;
          } else if (name === 'src') {
            if (!SAFE_IMG_SRC.test(val)) continue;
          } else if (name === 'style') {
            // Only retain text-align declarations.
            const matched = val.split(';').map(s => s.trim()).filter(Boolean)
              .filter(d => ALLOWED_STYLE.test(d + ';'))
              .join('; ');
            if (!matched) continue;
            val = matched;
          } else if (name === 'target') {
            // Force safe target/rel pair.
            val = '_blank';
            target.setAttribute('rel', 'noopener noreferrer');
          } else if (name === 'colspan' || name === 'rowspan') {
            const n = parseInt(val, 10);
            if (!(n > 0 && n < 100)) continue;
            val = String(n);
          }
          target.setAttribute(name, val);
        }
      }

      for (const child of node.childNodes) {
        const c = clean(child);
        if (c) target.appendChild(c);
      }
      return target;
    }

    // DIV → P (TipTap's preferred block) so legacy content survives.
    if (tag === 'DIV') {
      const p = document.createElement('p');
      for (const child of node.childNodes) {
        const c = clean(child);
        if (c) p.appendChild(c);
      }
      return p;
    }

    // Unknown tag: unwrap (keep children as siblings).
    const frag = document.createDocumentFragment();
    for (const child of node.childNodes) {
      const c = clean(child);
      if (c) frag.appendChild(c);
    }
    return frag;
  }

  const out = document.createElement('div');
  for (const child of doc.body.childNodes) {
    const c = clean(child);
    if (c) out.appendChild(c);
  }
  return out.innerHTML;
}
