// ============================================================
// editor.js — Mounts the contenteditable editor for the active chapter.
// Wires: typing → debounced save, toolbar, paste sanitizer, paragraph normalizer.
// ============================================================

import { toggleInline, toggleBlock, insertSceneBreak, sanitizeHtml, activeFormats } from './format.js';
import { stats } from './stats.js';
import { debounce } from './utils.js';

let editorEl = null;
let titleEl = null;
let toolbarEl = null;
let onChange = null;          // callback(html, title) — debounced
let currentChapter = null;    // reference; we only mutate local fields here

/**
 * Mount the editor. Call once on app boot.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.editorEl   the contenteditable root
 * @param {HTMLElement} opts.titleEl    the chapter title <input>
 * @param {HTMLElement} opts.toolbarEl  the toolbar container (data-cmd buttons)
 * @param {(chapter)=>void} opts.onChange called debounced after edits
 */
export function mountEditor(opts) {
  editorEl = opts.editorEl;
  titleEl = opts.titleEl;
  toolbarEl = opts.toolbarEl;
  onChange = opts.onChange;

  // ============ Toolbar wiring ============
  toolbarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-btn');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (!cmd) return;
    e.preventDefault();
    editorEl.focus();
    runCommand(cmd);
    refreshToolbar();
  });

  // ============ Keyboard shortcuts (B, I) ============
  // We let the BROWSER handle Cmd+B / Cmd+I natively (review fix H6).
  // Native execCommand-based formatting participates in the undo stack;
  // our toolbar buttons only run our custom toggleInline for clean HTML.
  // After native formatting fires, the 'input' event handler below picks up
  // the change and triggers the debounced save.
  editorEl.addEventListener('beforeinput', (e) => {
    // No-op — keep this listener around in case we want to intercept other inputTypes later.
  });

  // ============ Input event → debounced change ============
  editorEl.addEventListener('input', () => {
    // First-paragraph normalization: ensure root only ever contains block-level children.
    normalizeRoot(editorEl);
    fireChange();
    refreshToolbar();
  });

  // Selection change → toolbar refresh (active state).
  document.addEventListener('selectionchange', () => {
    if (!editorEl.contains(document.activeElement) && document.activeElement !== editorEl) return;
    refreshToolbar();
  });

  // ============ Paste sanitization ============
  editorEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    let toInsert;
    if (html) {
      toInsert = sanitizeHtml(html);
    } else if (text) {
      // Plain text — split on \n\n into paragraphs.
      toInsert = text
        .split(/\n{2,}/)
        .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
    }
    if (!toInsert) return;
    // execCommand('insertHTML') participates in undo stack reliably.
    document.execCommand('insertHTML', false, toInsert);
    fireChange();
  });

  // ============ Title input ============
  titleEl.addEventListener('input', () => fireChange());

  // ============ Drop = paste in disguise; always preventDefault and sanitize.
  //              Reject file drops outright (review fix H9).
  editorEl.addEventListener('dragover', (e) => e.preventDefault());
  editorEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      // File drops would otherwise navigate or insert raw <img>. Refuse.
      return;
    }
    const html = e.dataTransfer?.getData('text/html');
    const text = e.dataTransfer?.getData('text/plain');
    if (!html && !text) return;

    // Position the caret at the drop point so insertHTML lands where the user dropped.
    const docCaret = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(e.clientX, e.clientY)
      : (document.caretPositionFromPoint
          ? (() => {
              const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
              if (!pos) return null;
              const r = document.createRange();
              r.setStart(pos.offsetNode, pos.offset);
              r.collapse(true);
              return r;
            })()
          : null);
    if (docCaret) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(docCaret);
    }

    const clean = html ? sanitizeHtml(html) : `<p>${escapeHtml(text)}</p>`;
    document.execCommand('insertHTML', false, clean);
    fireChange();
  });
}

/** Load a chapter into the editor. */
export function loadChapter(chapter) {
  currentChapter = chapter;
  editorEl.innerHTML = chapter.html || '';
  titleEl.value = chapter.title || '';
  // If empty, normalize to one empty <p> so cursor + drop cap behave.
  if (!editorEl.firstChild) {
    editorEl.innerHTML = '<p><br></p>';
  }
  refreshToolbar();
  refreshWordCount();
}

/** Returns current chapter snapshot (title + html). */
export function snapshotChapter() {
  return {
    title: titleEl.value,
    html: editorEl.innerHTML,
  };
}

// ============ INTERNAL HELPERS ============

const fireChangeDebounced = debounce(() => {
  if (!currentChapter || !onChange) return;
  const snap = snapshotChapter();
  refreshWordCount(snap.html);
  onChange({ ...currentChapter, ...snap });
}, 600, { maxWait: 8000 });

function fireChange() {
  refreshWordCount();
  fireChangeDebounced();
}

/** Flush any pending debounced change immediately (call before swapping chapters). */
export function flushPending() {
  fireChangeDebounced.flush?.();
}

/** Cancel any pending debounced change without firing it (call after replacing the doc). */
export function cancelPending() {
  fireChangeDebounced.cancel?.();
}

function refreshWordCount(html) {
  const s = stats(html ?? editorEl.innerHTML);
  const wc = document.getElementById('chapter-word-count');
  const rt = document.getElementById('chapter-reading-time');
  if (wc) wc.textContent = s.words;
  if (rt) rt.textContent = s.readingLabel;
}

function refreshToolbar() {
  const fmts = activeFormats(editorEl);
  toolbarEl.querySelectorAll('.tb-btn').forEach(btn => {
    const cmd = btn.dataset.cmd;
    btn.classList.toggle('active',
      (cmd === 'bold' && fmts.has('bold')) ||
      (cmd === 'italic' && fmts.has('italic')) ||
      (cmd === 'h1' && fmts.has('h1')) ||
      (cmd === 'h2' && fmts.has('h2')) ||
      (cmd === 'blockquote' && fmts.has('blockquote'))
    );
  });
}

function runCommand(cmd) {
  switch (cmd) {
    case 'bold':       return toggleInline(editorEl, 'strong');
    case 'italic':     return toggleInline(editorEl, 'em');
    case 'h1':         return toggleBlock(editorEl, 'h1');
    case 'h2':         return toggleBlock(editorEl, 'h2');
    case 'blockquote': return toggleBlock(editorEl, 'blockquote');
    case 'paragraph':  return toggleBlock(editorEl, 'p');
    case 'scenebreak': return insertSceneBreak(editorEl);
  }
}

/**
 * Ensure the editor's direct children are all block-level.
 * Stray text nodes / inline children at the root cause weird behavior
 * (no first-line indent, drop cap doesn't apply). Wrap them in <p>.
 */
function normalizeRoot(root) {
  let changed = false;
  const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'UL', 'OL']);
  for (const node of [...root.childNodes]) {
    if (node.nodeType === 1 && blockTags.has(node.tagName)) continue;
    if (node.nodeType === 3 && !node.textContent.trim()) {
      root.removeChild(node);
      changed = true;
      continue;
    }
    // Wrap stray nodes — but ONLY if we're not currently typing into one
    // (would steal the caret). Safer: skip if the selection is inside it.
    const sel = window.getSelection();
    if (sel?.rangeCount && node.contains(sel.anchorNode)) continue;
    const p = document.createElement('p');
    node.replaceWith(p);
    p.appendChild(node);
    changed = true;
  }
  return changed;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
