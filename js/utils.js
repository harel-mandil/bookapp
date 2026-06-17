// ============================================================
// utils.js — small helpers used everywhere.
// ============================================================

/** Debounce — delays calling fn until `wait` ms have passed since last call.
 *  If maxWait is provided, fn fires at least once per maxWait while called.
 */
export function debounce(fn, wait = 800, { maxWait } = {}) {
  let timer = null;
  let firstCallAt = 0;
  let lastArgs = null;
  let lastThis = null;

  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    firstCallAt = 0;
    fn.apply(lastThis, lastArgs);
  };

  const debounced = function (...args) {
    lastArgs = args;
    lastThis = this;
    if (!firstCallAt) firstCallAt = Date.now();
    if (timer) clearTimeout(timer);

    if (maxWait && Date.now() - firstCallAt >= maxWait) {
      flush();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      firstCallAt = 0;
      fn.apply(lastThis, lastArgs);
    }, wait);
  };

  debounced.flush = flush;
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstCallAt = 0;
  };
  return debounced;
}

/** Stable id generator — used for chapters, ideas, snapshots. */
export function uid(prefix = '') {
  // crypto.randomUUID is in every browser since 2022.
  return prefix + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
}

/** Format a Date for display: "Today 14:32", "Yesterday 09:01", "Mar 4, 14:32". */
export function fmtTime(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = date.toDateString() === yest.toDateString();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `Today ${hh}:${mm}`;
  if (isYest) return `Yesterday ${hh}:${mm}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` ${hh}:${mm}`;
}

/** YYYY-MM-DD for the local date (used as session key). */
export function todayKey(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Show a transient toast at the bottom of the screen. */
let toastTimer = null;
export function toast(message, kind = '', ms = 2400) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = kind;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** Sleep — for backoff. */
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Escape HTML for safe injection into innerHTML contexts. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string for use inside a Drive API q='...' literal. */
export function driveEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** ISO timestamp safe for filenames: 2026-06-17T14-30-22Z */
export function isoForFilename(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}
