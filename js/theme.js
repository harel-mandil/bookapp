// ============================================================
// theme.js — Light / Dark / System theming.
//
// Persistence: meta.theme = 'light' | 'dark' | 'system' (default 'system').
// Application: writes data-theme="light"|"dark" on <html>, or removes the
// attribute entirely when in 'system' mode (so the prefers-color-scheme
// media query in tokens.css takes over).
//
// API:
//   await initTheme()          → call once on boot. Reads meta + applies.
//   getTheme()                 → 'light' | 'dark' | 'system'
//   getEffectiveTheme()        → 'light' | 'dark'  (resolves 'system')
//   setTheme(t)                → persists + applies
//   toggleTheme()              → cycles light → dark → light;
//                                 (does NOT cycle through system — if you
//                                  were on system, the toggle picks the
//                                  opposite of whatever the OS says)
// ============================================================

import * as db from './db.js';

let _theme = 'system';
let _mql = null;

const root = () => document.documentElement;

function applyAttribute(theme) {
  if (theme === 'system') {
    root().removeAttribute('data-theme');
  } else {
    root().setAttribute('data-theme', theme);
  }
}

export async function initTheme() {
  _theme = (await db.metaGet('theme', 'system')) || 'system';
  applyAttribute(_theme);

  // Re-apply when OS preference changes while in 'system' mode.
  _mql = window.matchMedia('(prefers-color-scheme: dark)');
  _mql.addEventListener?.('change', () => {
    if (_theme === 'system') {
      // Re-bouncing the attribute is a no-op visually (it's already absent),
      // but we fire an event so any listeners (e.g. icon refresh) can update.
      window.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: _theme, effective: getEffectiveTheme() } }));
    }
  });
  window.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: _theme, effective: getEffectiveTheme() } }));
}

export function getTheme() { return _theme; }

export function getEffectiveTheme() {
  if (_theme === 'light' || _theme === 'dark') return _theme;
  return _mql?.matches ? 'dark' : 'light';
}

export async function setTheme(t) {
  if (!['light', 'dark', 'system'].includes(t)) return;
  _theme = t;
  await db.metaSet('theme', t);
  applyAttribute(t);
  window.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: t, effective: getEffectiveTheme() } }));
}

export async function toggleTheme() {
  const eff = getEffectiveTheme();
  await setTheme(eff === 'dark' ? 'light' : 'dark');
}
