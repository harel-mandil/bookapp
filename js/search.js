// ============================================================
// search.js — Cross-chapter find / replace.
//
// Uses a regex over each chapter's plain text (extracted from HTML by
// dropping tags) to compute matches without touching the DOM. The match
// list is sorted by chapter index + match offset.
//
// API:
//   setupSearch({ getDoc, setActiveChapter, getActiveChapterId,
//                 scrollToCurrentMatch, applyReplacementToChapter })
//   open()                — show the cross-chapter find bar
//   close()
//   isOpen()
// ============================================================

import { escapeHtml } from './utils.js';

let _state = {
  open: false,
  query: '',
  matches: [],   // [{ chapterId, chapterIdx, chapterTitle, start, end, before, after, snippet }]
  cursor: -1,
  caseSensitive: false,
};
let _hooks = null;
let _bar = null;

export function setupSearch(hooks) {
  _hooks = hooks;
  ensureBar();
}

function ensureBar() {
  if (_bar) return;
  _bar = document.getElementById('search-bar');
  if (!_bar) return;
  // Wire all controls.
  _bar.querySelector('[data-search="close"]')?.addEventListener('click', close);
  _bar.querySelector('[data-search="next"]')?.addEventListener('click', () => step(+1));
  _bar.querySelector('[data-search="prev"]')?.addEventListener('click', () => step(-1));
  _bar.querySelector('[data-search="replace"]')?.addEventListener('click', replaceCurrent);
  _bar.querySelector('[data-search="replace-all"]')?.addEventListener('click', replaceAll);
  const q = _bar.querySelector('input[name=q]');
  q?.addEventListener('input', () => { _state.query = q.value; recompute(); });
  q?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : +1); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  _bar.querySelector('input[name=case]')?.addEventListener('change', (e) => {
    _state.caseSensitive = !!e.target.checked;
    recompute();
  });
}

export function open() {
  ensureBar();
  if (!_bar) return;
  _state.open = true;
  _bar.hidden = false;
  const q = _bar.querySelector('input[name=q]');
  q.value = _state.query || '';
  q.focus();
  q.select?.();
  recompute();
}

export function close() {
  if (!_bar) return;
  _state.open = false;
  _bar.hidden = true;
}

export function isOpen() { return _state.open; }

function recompute() {
  const doc = _hooks?.getDoc?.();
  if (!doc) return;
  _state.matches = [];
  _state.cursor = -1;
  const q = _state.query || '';
  if (!q) { renderStats(); return; }
  const flags = _state.caseSensitive ? 'g' : 'gi';
  const re = new RegExp(escapeRegex(q), flags);
  doc.chapters.forEach((ch, idx) => {
    const text = htmlToText(ch.html || '');
    let m;
    while ((m = re.exec(text)) !== null) {
      _state.matches.push({
        chapterId: ch.id,
        chapterIdx: idx,
        chapterTitle: ch.title || `Chapter ${idx + 1}`,
        start: m.index,
        end: m.index + m[0].length,
        snippet: snippetAround(text, m.index, m[0].length),
      });
      if (m[0].length === 0) re.lastIndex++; // safety
    }
  });
  // Position cursor on first match in active chapter, else first overall.
  const activeId = _hooks?.getActiveChapterId?.();
  const firstIn = _state.matches.findIndex(m => m.chapterId === activeId);
  _state.cursor = firstIn >= 0 ? firstIn : (_state.matches.length ? 0 : -1);
  renderStats();
  if (_state.cursor >= 0) jumpTo(_state.cursor);
}

function step(dir) {
  if (!_state.matches.length) return;
  _state.cursor = (_state.cursor + dir + _state.matches.length) % _state.matches.length;
  renderStats();
  jumpTo(_state.cursor);
}

function jumpTo(idx) {
  const m = _state.matches[idx];
  if (!m) return;
  if (_hooks?.getActiveChapterId?.() !== m.chapterId) {
    _hooks.setActiveChapter(m.chapterId);
  }
  // Defer scroll until chapter has rendered.
  setTimeout(() => _hooks?.scrollToCurrentMatch?.(_state.query, idx, m), 60);
}

function replaceCurrent() {
  const replacement = _bar.querySelector('input[name=r]')?.value ?? '';
  const m = _state.matches[_state.cursor];
  if (!m) return;
  _hooks?.applyReplacementToChapter?.(m.chapterId, _state.query, replacement, /* once */ true, _state.caseSensitive);
  // Recompute matches; cursor may shift.
  setTimeout(recompute, 30);
}

function replaceAll() {
  const replacement = _bar.querySelector('input[name=r]')?.value ?? '';
  if (!_state.matches.length) return;
  if (!confirm(`Replace ${_state.matches.length} occurrence(s) of "${_state.query}" across the whole book?`)) return;
  // Group by chapter so we touch each chapter once.
  const ids = [...new Set(_state.matches.map(m => m.chapterId))];
  ids.forEach(id => {
    _hooks?.applyReplacementToChapter?.(id, _state.query, replacement, /* once */ false, _state.caseSensitive);
  });
  setTimeout(recompute, 30);
}

function renderStats() {
  if (!_bar) return;
  const stats = _bar.querySelector('.find-stats');
  if (!stats) return;
  if (!_state.query) { stats.textContent = ''; return; }
  if (!_state.matches.length) { stats.textContent = '0 matches'; return; }
  stats.textContent = `${_state.cursor + 1} of ${_state.matches.length}`;
}

// ============ helpers ============

export function htmlToText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  return tpl.content.textContent || '';
}

function snippetAround(text, start, len, ctx = 30) {
  const s = Math.max(0, start - ctx);
  const e = Math.min(text.length, start + len + ctx);
  let snip = text.slice(s, e).replace(/\s+/g, ' ').trim();
  if (s > 0) snip = '…' + snip;
  if (e < text.length) snip += '…';
  return snip;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Replace all occurrences in HTML text nodes, preserving tags. */
export function replaceInHtml(html, find, replace, caseSensitive, oncePerCall) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const flags = (caseSensitive ? 'g' : 'gi') + (oncePerCall ? '' : '');
  let re = new RegExp(escapeRegex(find), flags);
  let replaced = 0;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (oncePerCall && replaced > 0) break;
    if (re.test(n.nodeValue)) {
      n.nodeValue = oncePerCall
        ? n.nodeValue.replace(new RegExp(escapeRegex(find), caseSensitive ? '' : 'i'), replace)
        : n.nodeValue.replace(new RegExp(escapeRegex(find), caseSensitive ? 'g' : 'gi'), replace);
      replaced++;
    }
    re.lastIndex = 0;
  }
  return tpl.innerHTML;
}
