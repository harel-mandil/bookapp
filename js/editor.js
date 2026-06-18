// ============================================================
// editor.js — Vanilla contenteditable editor (no external deps).
//
// Why not a framework? After trying TipTap from a CDN, transient network
// failures pulling 11 sub-bundles made the editor unusable. This rewrite
// uses what every browser has shipped for 20 years: contenteditable +
// document.execCommand. Zero dependencies, instant boot, native undo.
//
// Supported features:
//   Bold, Italic, Underline, Strike     execCommand
//   H1, H2, Paragraph, Blockquote        formatBlock
//   Bullet & numbered lists              insertUnorderedList / insertOrderedList
//   Alignment (left/center/right/justify) justifyLeft/Center/Right/Full
//   Undo / Redo                          native (execCommand)
//   Link (prompt for URL)                custom + createLink
//   Image (URL or upload, base64)        insertHTML with sanitized <img>
//   Table (3x3 with header row)          insertHTML
//   Scene break ⁂                        insertHTML <p class="scene-break">
//   Paste sanitization                   beforeinput / paste handler + sanitizeHtml
//   Find / Replace (per-chapter)         TreeWalker scan + Range
//
// Public API (unchanged from before — main.js doesn't need updating):
//   mountEditor({editorEl, titleEl, toolbarEl, onChange})
//   loadChapter(chapter)
//   snapshotChapter() -> {title, html}
//   flushPending()
//   cancelPending()
//
// IMPORTANT — execCommand is technically deprecated, but no browser is
// removing it any time soon (Google Docs, Notion, Substack all rely on it).
// It's the simplest reliable way to wire a contenteditable to native
// formatting + undo. When that finally changes, swap the implementation
// here without touching main.js.
// ============================================================

import { stats } from './stats.js';
import { debounce, escapeHtml } from './utils.js';
import { sanitizeHtml } from './sanitize.js';
import { attach as attachTypography } from './typography.js';

let editorEl = null;
let titleEl = null;
let toolbarEl = null;
let onChange = null;
let currentChapter = null;
let suppressChange = false;   // true while we're loading a chapter

/**
 * Mount the editor. Called once on app boot.
 * Despite being synchronous internally, the signature stays async so existing
 * callers (`await mountEditor(...)`) keep working.
 */
export async function mountEditor(opts) {
  editorEl = opts.editorEl;
  titleEl = opts.titleEl;
  toolbarEl = opts.toolbarEl;
  onChange = opts.onChange;

  editorEl.contentEditable = 'true';
  editorEl.spellcheck = true;

  // ============ TOOLBAR ============
  toolbarEl.addEventListener('mousedown', (e) => {
    // mousedown (not click) so the editor never loses focus and the
    // selection survives — execCommand needs a live selection.
    const btn = e.target.closest('.tb-btn');
    if (!btn || !btn.dataset.cmd) return;
    e.preventDefault();
    runCommand(btn.dataset.cmd);
  });

  // ============ TYPING ============
  editorEl.addEventListener('input', () => {
    if (suppressChange) return;
    normalizeRoot();
    fireChange();
    refreshToolbar();
  });
  editorEl.addEventListener('keyup',   refreshToolbar);
  editorEl.addEventListener('mouseup', refreshToolbar);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== editorEl) return;
    refreshToolbar();
  });

  // ============ KEYBOARD SHORTCUTS ============
  editorEl.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    // Native B/I/U already work; we just intercept K for link.
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      promptLink();
    }
  });

  // ============ PASTE ============
  // Paste = sanitize HTML so Word/Google Docs styles don't pollute the doc.
  editorEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    let toInsert;
    if (html) {
      toInsert = sanitizeHtml(html);
    } else if (text) {
      toInsert = text.split(/\n{2,}/)
        .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
    }
    if (!toInsert) return;
    document.execCommand('insertHTML', false, toInsert);
    fireChange();
  });

  // ============ DROP — accept image files; reject other files ============
  editorEl.addEventListener('dragover', (e) => e.preventDefault());
  editorEl.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    const img = files.find(f => /^image\//.test(f.type));
    if (img) {
      e.preventDefault();
      readFileAsDataUrl(img).then(src => {
        moveCaretToDropPoint(e);
        insertImageDataUrl(src, img.name);
      });
      return;
    }
    if (files.length) {
      // Non-image file — let the chapter list handler take it (drag-drop
      // import). We just block the editor from ingesting it as garbage.
      e.preventDefault();
      return;
    }
    // HTML / text drop — sanitize.
    const html = e.dataTransfer?.getData('text/html');
    const text = e.dataTransfer?.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    moveCaretToDropPoint(e);
    const clean = html ? sanitizeHtml(html) : `<p>${escapeHtml(text)}</p>`;
    document.execCommand('insertHTML', false, clean);
    fireChange();
  });

  // ============ TITLE FIELD ============
  titleEl.addEventListener('input', () => {
    if (suppressChange) return;
    fireChange();
  });

  refreshToolbar();
  refreshWordCount();

  // Smart-typography input hook (toggleable via setSmartTypography).
  attachTypography(editorEl);
}

/** Expose the editor DOM node for modules like paginate.js / search.js. */
export function getEditorElement() { return editorEl; }

// ============ CHAPTER LOAD / SAVE ============

/** Load a chapter into the editor. */
export function loadChapter(chapter) {
  currentChapter = chapter;
  suppressChange = true;
  try {
    editorEl.innerHTML = chapter.html || '<p><br></p>';
    titleEl.value = chapter.title || '';
    if (!editorEl.firstChild) editorEl.innerHTML = '<p><br></p>';
  } finally {
    // Release on next tick so the input event fired by setting innerHTML/value doesn't fire change.
    setTimeout(() => { suppressChange = false; }, 0);
  }
  refreshToolbar();
  refreshWordCount();
  notifyTocDirty();
}

/** Returns the current chapter snapshot (title + html). */
export function snapshotChapter() {
  return {
    title: titleEl ? titleEl.value : (currentChapter?.title ?? ''),
    html: editorEl ? sanitizeHtml(stripPageBreaks(editorEl.innerHTML)) : (currentChapter?.html ?? ''),
  };
}

/** Strip the visual page-break HRs paginate.js injects — they're presentational. */
function stripPageBreaks(html) {
  return String(html || '').replace(/<hr[^>]*class=["'][^"']*page-break[^"']*["'][^>]*>/gi, '');
}

// ============ DEBOUNCED CHANGE NOTIFICATION ============

const fireChangeDebounced = debounce(() => {
  if (!currentChapter || !onChange) return;
  const snap = snapshotChapter();
  onChange({ ...currentChapter, ...snap });
  notifyTocDirty();
}, 600, { maxWait: 8000 });

function fireChange() {
  refreshWordCount();
  fireChangeDebounced();
}

/** Flush pending debounce — call before swapping chapters. */
export function flushPending() { fireChangeDebounced.flush?.(); }

/** Cancel pending debounce — call after replacing the doc. */
export function cancelPending() { fireChangeDebounced.cancel?.(); }

// ============ COMMAND DISPATCH ============

function runCommand(cmd) {
  editorEl.focus();
  // execCommand needs a live selection — restore one if focus was lost.
  const sel = window.getSelection();
  if (!sel.rangeCount) {
    const r = document.createRange();
    r.selectNodeContents(editorEl);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  switch (cmd) {
    case 'bold':           document.execCommand('bold');                    break;
    case 'italic':         document.execCommand('italic');                  break;
    case 'underline':      document.execCommand('underline');               break;
    case 'strike':         document.execCommand('strikeThrough');           break;
    case 'h1':             toggleBlock('H1');                                break;
    case 'h2':             toggleBlock('H2');                                break;
    case 'paragraph':      toggleBlock('P');                                 break;
    case 'blockquote':     toggleBlock('BLOCKQUOTE');                        break;
    case 'bulletList':     document.execCommand('insertUnorderedList');     break;
    case 'orderedList':    document.execCommand('insertOrderedList');       break;
    case 'align-left':     document.execCommand('justifyLeft');             break;
    case 'align-center':   document.execCommand('justifyCenter');           break;
    case 'align-right':    document.execCommand('justifyRight');            break;
    case 'align-justify':  document.execCommand('justifyFull');             break;
    case 'undo':           document.execCommand('undo');                    break;
    case 'redo':           document.execCommand('redo');                    break;
    case 'link':           promptLink();                                    break;
    case 'image':          promptImage();                                   break;
    case 'table':          insertTable(3, 3);                                break;
    case 'scenebreak':     insertSceneBreak();                              break;
    case 'find':           openFindBar();                                   break;
  }
  fireChange();
  refreshToolbar();
}

/** Toggle a block-level format on the current paragraph. P is the default. */
function toggleBlock(tag) {
  // formatBlock is the most reliable way; it round-trips through native undo.
  document.execCommand('formatBlock', false, tag);
}

// ============ LINK ============

function promptLink() {
  const sel = window.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  // If no selection, ask for the link text first.
  let text = range && !range.collapsed ? range.toString() : '';
  if (!text) {
    text = window.prompt('Link text:') || '';
    if (!text) return;
  }
  const url = window.prompt('Link URL:', 'https://');
  if (!url) return;
  const safe = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
  if (range && !range.collapsed) {
    document.execCommand('createLink', false, safe);
    // Set rel/target on the new <a>.
    setTimeout(() => {
      editorEl.querySelectorAll('a[href]').forEach(a => {
        if (a.getAttribute('href') === safe && !a.target) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      });
    }, 0);
  } else {
    const html = `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
    document.execCommand('insertHTML', false, html);
  }
}

// ============ IMAGE ============

function promptImage() {
  const choice = window.prompt('Paste an image URL, or leave blank to upload from your computer:');
  if (choice === null) return;
  const url = (choice || '').trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) { alert('URL must start with http(s)://'); return; }
    insertImageDataUrl(url, '');
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024 &&
        !confirm(`That image is ${(f.size / 1024 / 1024).toFixed(1)} MB. Embedding large images bloats your book file. Continue?`)) {
      return;
    }
    const src = await readFileAsDataUrl(f);
    insertImageDataUrl(src, f.name);
  };
  inp.click();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function insertImageDataUrl(src, alt) {
  // Wrap in a centered figure block so the page layout doesn't break.
  const html =
    `<figure contenteditable="false" style="text-align:center;">` +
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}">` +
    `</figure><p><br></p>`;
  document.execCommand('insertHTML', false, html);
  fireChange();
}

// ============ TABLE ============

function insertTable(rows, cols) {
  let html = '<table class="editor-table"><thead><tr>';
  for (let c = 0; c < cols; c++) html += `<th>Col ${c + 1}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 0; r < rows - 1; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>';
    html += '</tr>';
  }
  html += '</tbody></table><p><br></p>';
  document.execCommand('insertHTML', false, html);
}

// ============ SCENE BREAK ============

function insertSceneBreak() {
  document.execCommand('insertHTML', false, '<p class="scene-break" contenteditable="false"></p><p><br></p>');
}

// ============ DROP CARET POSITIONING ============

function moveCaretToDropPoint(e) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(e.clientX, e.clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (range) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ============ NORMALIZATION ============

/** Make sure the editor's direct children are block-level. Wrap stray nodes. */
function normalizeRoot() {
  const blockTags = new Set(['P','H1','H2','H3','H4','BLOCKQUOTE','UL','OL','TABLE','FIGURE','PRE','HR']);
  for (const node of [...editorEl.childNodes]) {
    if (node.nodeType === 1 && blockTags.has(node.tagName)) continue;
    if (node.nodeType === 3 && !node.textContent.trim()) {
      editorEl.removeChild(node);
      continue;
    }
    // Skip if the caret is currently in this node (would steal focus).
    const sel = window.getSelection();
    if (sel?.rangeCount && node.contains(sel.anchorNode)) continue;
    const p = document.createElement('p');
    node.replaceWith(p);
    p.appendChild(node);
  }
}

// ============ TOOLBAR STATE ============

function refreshToolbar() {
  if (!toolbarEl) return;
  const checks = {
    bold:        () => safeQuery('bold'),
    italic:      () => safeQuery('italic'),
    underline:   () => safeQuery('underline'),
    strike:      () => safeQuery('strikeThrough'),
    h1:          () => isBlock('H1'),
    h2:          () => isBlock('H2'),
    paragraph:   () => isBlock('P'),
    blockquote:  () => isBlock('BLOCKQUOTE'),
    bulletList:  () => safeQuery('insertUnorderedList'),
    orderedList: () => safeQuery('insertOrderedList'),
    'align-left':    () => safeQuery('justifyLeft'),
    'align-center':  () => safeQuery('justifyCenter'),
    'align-right':   () => safeQuery('justifyRight'),
    'align-justify': () => safeQuery('justifyFull'),
  };
  toolbarEl.querySelectorAll('.tb-btn').forEach(btn => {
    const cmd = btn.dataset.cmd;
    const fn = checks[cmd];
    btn.classList.toggle('active', !!(fn && fn()));
  });
}

function safeQuery(name) {
  try { return document.queryCommandState(name); } catch { return false; }
}

function isBlock(tag) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  let n = sel.anchorNode;
  while (n && n !== editorEl) {
    if (n.nodeType === 1 && n.tagName === tag) return true;
    n = n.parentNode;
  }
  return false;
}

function refreshWordCount(html) {
  if (!editorEl) return;
  const s = stats(html ?? editorEl.innerHTML);
  const wc = document.getElementById('chapter-word-count');
  const rt = document.getElementById('chapter-reading-time');
  if (wc) wc.textContent = s.words;
  if (rt) rt.textContent = s.readingLabel;
}

// Tell the world the chapter outline has changed (TOC panel listens).
function notifyTocDirty() {
  window.dispatchEvent(new CustomEvent('book:toc-dirty'));
}

// ============ FIND / REPLACE ============

let findBar = null;
let findMatches = [];   // [{from: Range start info, to: ...}]
let findIdx = -1;
let lastQuery = '';

function openFindBar() {
  if (!findBar) {
    findBar = document.getElementById('find-bar');
    if (!findBar) return;
    findBar.querySelector('[data-find=close]')?.addEventListener('click', closeFindBar);
    findBar.querySelector('[data-find=next]')?.addEventListener('click', () => findStep(+1));
    findBar.querySelector('[data-find=prev]')?.addEventListener('click', () => findStep(-1));
    findBar.querySelector('[data-find=replace]')?.addEventListener('click', findReplaceOne);
    findBar.querySelector('[data-find=replace-all]')?.addEventListener('click', findReplaceAll);
    findBar.querySelector('input[name=q]')?.addEventListener('input', findReset);
    findBar.querySelector('input[name=q]')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : +1); }
      if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
    });
  }
  findBar.hidden = false;
  findBar.querySelector('input[name=q]')?.focus();
  findBar.querySelector('input[name=q]')?.select();
}

function closeFindBar() {
  if (findBar) findBar.hidden = true;
  editorEl?.focus();
}

function findReset() { findMatches = []; findIdx = -1; lastQuery = ''; }

function collectMatches(query) {
  const q = (query || '').toLowerCase();
  if (!q) return [];
  const out = [];
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue.toLowerCase();
    let idx = 0;
    while ((idx = text.indexOf(q, idx)) !== -1) {
      out.push({ node, start: idx, end: idx + q.length });
      idx += q.length;
    }
  }
  return out;
}

function findStep(dir) {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  if (!q) return;
  if (q !== lastQuery) {
    findMatches = collectMatches(q);
    findIdx = -1;
    lastQuery = q;
  }
  if (!findMatches.length) return;
  findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
  const m = findMatches[findIdx];
  const range = document.createRange();
  range.setStart(m.node, m.start);
  range.setEnd(m.node, m.end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // Scroll into view.
  const rect = range.getBoundingClientRect();
  const wrap = document.querySelector('.book-page-wrap');
  if (wrap && (rect.top < 80 || rect.bottom > wrap.clientHeight - 80)) {
    wrap.scrollBy({ top: rect.top - 200, behavior: 'smooth' });
  }
}

function findReplaceOne() {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  const r = findBar?.querySelector('input[name=r]')?.value || '';
  if (!q) return;
  const sel = window.getSelection();
  const selText = sel.toString();
  if (selText.toLowerCase() === q.toLowerCase() && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(r));
    fireChange();
    findReset();
    findStep(+1);
  } else {
    findStep(+1);
  }
}

function findReplaceAll() {
  const q = findBar?.querySelector('input[name=q]')?.value || '';
  const r = findBar?.querySelector('input[name=r]')?.value || '';
  if (!q) return;
  // Walk text nodes, replacing in-place. Simpler than range-based for "replace all".
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT, null);
  const re = new RegExp(escapeRegex(q), 'gi');
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (re.test(node.nodeValue)) targets.push(node);
    re.lastIndex = 0;
  }
  for (const t of targets) {
    t.nodeValue = t.nodeValue.replace(new RegExp(escapeRegex(q), 'gi'), r);
  }
  fireChange();
  findReset();
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
