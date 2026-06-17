// ============================================================
// format.js — Toolbar formatting actions for the editor.
//
// IMPORTANT (per research §5.1):
//  - We use Selection / Range APIs for B / I / H1 / H2 / blockquote /
//    paragraph toggles (predictable, clean HTML).
//  - We use document.execCommand('insertText') ONLY where we explicitly
//    need participation in the native undo stack — that's via beforeinput
//    handling in editor.js, not here.
//  - We sanitize on paste via DOMParser allow-list — also in editor.js.
// ============================================================

const ALLOWED_BLOCKS = ['P', 'H1', 'H2', 'BLOCKQUOTE'];

/** Find the nearest block-level ancestor for a node, contained within `root`. */
function nearestBlock(node, root) {
  let n = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && /^(P|H1|H2|H3|BLOCKQUOTE|DIV)$/.test(n.tagName)) return n;
    n = n.parentNode;
  }
  return null;
}

/**
 * Toggle inline formatting for the current selection.
 * tag: 'strong' | 'em'
 */
export function toggleInline(root, tag) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;

  // Detect: is the selection already entirely wrapped in this tag?
  // Cheap check — walk up from anchor and focus.
  const upTag = tag.toUpperCase();
  const inTag = (node) => {
    let n = node;
    while (n && n !== root) {
      if (n.nodeType === 1 && n.tagName === upTag) return n;
      n = n.parentNode;
    }
    return null;
  };
  const anchorIn = inTag(sel.anchorNode);
  const focusIn  = inTag(sel.focusNode);

  if (anchorIn && focusIn && anchorIn === focusIn) {
    // Unwrap: replace the wrapper with its children.
    const wrapper = anchorIn;
    const parent = wrapper.parentNode;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    parent.removeChild(wrapper);
    // Restore selection roughly.
    sel.removeAllRanges();
    return;
  }

  // Wrap: extract → wrap → reinsert.
  const wrapper = document.createElement(tag);
  try {
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    // Reselect the wrapped content.
    const r = document.createRange();
    r.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) {
    // Selection crossed block boundaries in a way extractContents can't handle cleanly.
    // Fallback to execCommand for these edge cases — it still works in 2026.
    document.execCommand(tag === 'strong' ? 'bold' : 'italic', false, null);
  }
}

/**
 * Toggle a block-level format on the current paragraph(s).
 * tag: 'p' | 'h1' | 'h2' | 'blockquote'
 *
 * If the selection spans multiple blocks, every block in the range is
 * converted (review fix H7).
 */
export function toggleBlock(root, tag) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const startBlock = nearestBlock(range.startContainer, root);
  const endBlock = nearestBlock(range.endContainer, root);
  if (!startBlock) return;

  // Collect every block between start and end (inclusive).
  const blocks = [];
  let n = startBlock;
  while (n) {
    blocks.push(n);
    if (n === endBlock) break;
    n = n.nextElementSibling;
    // Safety: don't run off the end of the editor.
    if (!n || !root.contains(n)) break;
  }

  const upTag = tag.toUpperCase();
  // If ALL selected blocks are already the target tag, toggle them back to <p>.
  const allMatch = blocks.every(b => b.tagName === upTag);
  const targetTag = allMatch ? 'P' : upTag;

  let firstReplacement = null;
  let lastReplacement = null;
  for (const block of blocks) {
    const replacement = document.createElement(targetTag);
    while (block.firstChild) replacement.appendChild(block.firstChild);
    block.replaceWith(replacement);
    if (!firstReplacement) firstReplacement = replacement;
    lastReplacement = replacement;
  }

  // Restore selection across the converted blocks.
  if (firstReplacement && lastReplacement) {
    const r = document.createRange();
    r.setStart(firstReplacement, 0);
    r.setEnd(lastReplacement, lastReplacement.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

/**
 * Insert a scene-break separator at the current caret.
 * <p class="scene-break"></p> — purely decorative, content via CSS ::before.
 */
export function insertSceneBreak(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const block = nearestBlock(range.startContainer, root);
  const sep = document.createElement('p');
  sep.className = 'scene-break';
  sep.contentEditable = 'false';

  const next = document.createElement('p');
  next.innerHTML = '<br>';

  if (block && block.parentNode === root) {
    block.after(sep);
    sep.after(next);
  } else {
    root.appendChild(sep);
    root.appendChild(next);
  }

  // Move caret into the new empty paragraph after the break.
  const r = document.createRange();
  r.setStart(next, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Sanitize incoming HTML (from paste, drop, import, snapshot restore).
 *
 * Allow-list approach: only known-safe tags survive. ALL attributes are
 * stripped. Tags not on the list are unwrapped (children kept as plain text /
 * siblings). This blocks: <script>, on* handlers, javascript:/data: URIs,
 * <iframe>, <object>, <embed>, <link>, <style>, etc.
 */
export function sanitizeHtml(rawHtml) {
  // DOMParser does NOT execute scripts — safe to parse untrusted content.
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  const allowedInline = new Set(['STRONG', 'B', 'EM', 'I', 'BR']);
  const allowedBlock = new Set(['P', 'H1', 'H2', 'BLOCKQUOTE']);
  // Tags whose children we drop entirely (their content is hostile or noise).
  const stripWithChildren = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT']);

  function clean(node) {
    if (node.nodeType === 3) return node;             // text — keep
    if (node.nodeType !== 1) return null;
    const tag = node.tagName;

    if (stripWithChildren.has(tag)) return null;

    let target;
    if (allowedBlock.has(tag) || allowedInline.has(tag)) {
      target = document.createElement(tag.toLowerCase());
      // Strip ALL attributes — paste from Word/Google Docs is ~99% style noise,
      // and stripping is the only sane way to block onload / onerror / style.
    } else if (tag === 'DIV') {
      target = document.createElement('p');
    } else {
      // Unknown tag — keep children as siblings (unwrap).
      const frag = document.createDocumentFragment();
      for (const child of node.childNodes) {
        const c = clean(child);
        if (c) frag.appendChild(c);
      }
      return frag;
    }

    for (const child of node.childNodes) {
      const c = clean(child);
      if (c) target.appendChild(c);
    }
    return target;
  }

  const out = document.createElement('div');
  for (const child of doc.body.childNodes) {
    const c = clean(child);
    if (c) out.appendChild(c);
  }
  return out.innerHTML;
}

/**
 * Walk active selection and report which formats are currently applied.
 * Used to highlight active toolbar buttons.
 */
export function activeFormats(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return new Set();
  const node = sel.anchorNode;
  const set = new Set();
  let n = node;
  while (n && n !== root) {
    if (n.nodeType === 1) {
      const t = n.tagName;
      if (t === 'STRONG' || t === 'B') set.add('bold');
      if (t === 'EM' || t === 'I') set.add('italic');
      if (t === 'H1') set.add('h1');
      if (t === 'H2') set.add('h2');
      if (t === 'BLOCKQUOTE') set.add('blockquote');
    }
    n = n.parentNode;
  }
  return set;
}
