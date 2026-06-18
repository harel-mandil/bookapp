// ============================================================
// focus.js — Distraction-free / focus mode.
//
// Adds `focus-mode` class to <body>; CSS hides sidebar, topbar, toolbar.
// Persists in meta (`focusMode: bool`) so it survives reloads.
//
// API:
//   await initFocus()
//   toggle()
//   enter()
//   exit()
//   isOn()
// ============================================================

import * as db from './db.js';

let _on = false;

export async function initFocus() {
  _on = !!(await db.metaGet('focusMode', false));
  apply();
  // Esc exits.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _on) { e.preventDefault(); exit(); }
  });
  document.getElementById('focus-exit-btn')?.addEventListener('click', exit);
}

export function isOn() { return _on; }

export async function enter() { _on = true; await db.metaSet('focusMode', true); apply(); }
export async function exit()  { _on = false; await db.metaSet('focusMode', false); apply(); }
export async function toggle() { _on ? await exit() : await enter(); }

function apply() {
  document.body.classList.toggle('focus-mode', _on);
}
