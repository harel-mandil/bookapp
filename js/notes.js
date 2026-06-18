// ============================================================
// notes.js — Per-chapter author notes (NOT exported; private scratchpad).
//
// Stored in meta as `notesByChapter: { [chapterId]: text }`.
// API:
//   await initNotes()
//   open(chapterId)    — show rail
//   close()
//   isOpen()
// ============================================================

import * as db from './db.js';
import { debounce } from './utils.js';

let _rail = null;
let _ta = null;
let _activeId = null;
let _all = {};
let _persist = null;

export async function initNotes() {
  _rail = document.getElementById('notes-rail');
  if (!_rail) return;
  _ta = _rail.querySelector('textarea');
  _all = (await db.metaGet('notesByChapter', {})) || {};
  _persist = debounce(async () => {
    if (!_activeId) return;
    _all[_activeId] = _ta.value;
    await db.metaSet('notesByChapter', _all);
  }, 400, { maxWait: 4000 });

  _ta?.addEventListener('input', () => _persist?.());
  _rail.querySelector('[data-notes="close"]')?.addEventListener('click', close);
}

export function open(chapterId) {
  if (!_rail) return;
  _activeId = chapterId;
  _ta.value = _all[chapterId] || '';
  _rail.classList.add('open');
  setTimeout(() => _ta.focus(), 60);
}

export function close() {
  _rail?.classList.remove('open');
}

export function isOpen() { return _rail?.classList.contains('open'); }
