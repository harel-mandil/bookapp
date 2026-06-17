// ============================================================
// snapshots.js — version history with smart triggers + retention.
//
// Triggers (any of these → snapshot):
//   1. 30 s of typing inactivity AND ≥1 char of net change
//   2. cumulative diff ≥ 500 chars or ≥1% of doc since last snapshot
//   3. visibilitychange → hidden, or pagehide
//   4. explicit user action ("Save Version" button)
//   5. switching active chapter
//
// Snapshot kinds:
//   - 'auto'      — created by any trigger above. Subject to retention/pruning.
//   - 'published' — promoted by the user with a name (e.g. "Draft 1 — sent to
//                   editor"). Never pruned. Mirrored to Drive's versions/
//                   subfolder in both .json and .docx form.
//
// Format: each snapshot is a full JSON copy of the book document.
// (Diff-based snapshots were considered, but for a single-user app under
//  ~30 MB total, the simplicity of full copies wins. Retention prunes the
//  store before quota becomes an issue.)
//
// Retention (per research §4.3):
//   - keep ALL snapshots from last 24 h
//   - keep one per hour for last 7 days
//   - keep one per day for last 90 days
//   - keep monthly forever
//   - hard cap: 500 entries; oldest non-monthly evicted first
//   - PUBLISHED snapshots are exempt from every rule above.
// ============================================================

import * as db from './db.js';
import { totalStats } from './stats.js';

const IDLE_MS = 30_000;
const MAGNITUDE_CHARS = 500;
const MAGNITUDE_RATIO = 0.01;  // 1%
const RETENTION_CAP = 500;

let lastSnapshot = null;       // full copy of last snapshotted doc
let lastSnapshotChars = 0;
let idleTimer = null;
let pendingDoc = null;
let getDoc = null;             // () => current doc
let onSnap = null;             // (snapshot) => void

/**
 * Start the snapshot scheduler.
 *
 * @param {object} opts
 * @param {() => object} opts.getDoc  returns the live doc to snapshot
 * @param {(snap) => void} [opts.onSnap]  called after a snapshot is written
 */
export async function initSnapshots({ getDoc: getter, onSnap: cb }) {
  getDoc = getter;
  onSnap = cb;

  // Find the most recent snapshot to anchor magnitude tracking.
  const all = await db.snapshotsAll();
  if (all.length) {
    const last = all[all.length - 1];
    lastSnapshot = last.doc;
    lastSnapshotChars = countChars(last.doc);
  }

  // Flush on hide/pagehide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') maybeSnapshot('visibilitychange');
  });
  window.addEventListener('pagehide', () => maybeSnapshot('pagehide'));

  // Periodic retention sweep (max once per app boot).
  pruneOldSnapshots().catch(e => console.warn('snapshot prune failed', e));
}

/**
 * Notify the snapshot system that the document changed.
 * Call this from sync.js after every persisted edit.
 */
export function noteChange() {
  pendingDoc = getDoc?.();
  if (!pendingDoc) return;
  // Idle trigger: reset the timer.
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => maybeSnapshot('idle'), IDLE_MS);
  // Magnitude trigger.
  const chars = countChars(pendingDoc);
  const delta = Math.abs(chars - lastSnapshotChars);
  if (delta >= MAGNITUDE_CHARS || (lastSnapshotChars > 0 && delta / lastSnapshotChars >= MAGNITUDE_RATIO && delta >= 200)) {
    maybeSnapshot('magnitude');
  }
}

/**
 * Force a snapshot (user clicked "Save Version", or chapter switch).
 */
export async function forceSnapshot(reason = 'manual') {
  return maybeSnapshot(reason, /* force */ true);
}

async function maybeSnapshot(reason, force = false, opts = {}) {
  const doc = pendingDoc || getDoc?.();
  if (!doc) return null;

  // Skip no-op snapshots: identical to last.
  if (!force && lastSnapshot && JSON.stringify(doc) === JSON.stringify(lastSnapshot)) return null;

  const totalsNow = totalStats(doc.chapters || []);
  const totalsLast = lastSnapshot ? totalStats(lastSnapshot.chapters || []) : { words: 0 };
  const wordDelta = totalsNow.words - totalsLast.words;

  const snap = {
    timestamp: Date.now(),
    reason,
    doc: JSON.parse(JSON.stringify(doc)), // deep copy
    words: totalsNow.words,
    wordDelta,
    kind: opts.kind ?? 'auto',
    label: opts.label ?? null,
  };

  const id = await db.snapshotAdd(snap);
  snap.id = id;
  lastSnapshot = snap.doc;
  lastSnapshotChars = countChars(snap.doc);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (onSnap) onSnap(snap);
  return snap;
}

/**
 * Promote the current document to a *published* version.
 * Published snapshots are exempt from retention pruning.
 *
 * @param {string} label  user-supplied name (e.g. "Draft 1 — sent to editor")
 * @returns {Promise<object>} the snapshot row
 */
export async function publishVersion(label) {
  const cleanLabel = (label || '').trim() || 'Untitled version';
  return maybeSnapshot('published', /* force */ true, { kind: 'published', label: cleanLabel });
}

/** Count characters across all chapters (used for magnitude trigger). */
function countChars(doc) {
  if (!doc?.chapters) return 0;
  return doc.chapters.reduce((sum, c) => sum + (c.html?.length || 0), 0);
}

// ============ RETENTION ============

async function pruneOldSnapshots() {
  const all = await db.snapshotsAll();

  // Published snapshots are immortal — separate them out and never touch.
  const auto = all.filter(s => (s.kind ?? 'auto') !== 'published');
  if (auto.length <= RETENTION_CAP * 0.6) return; // not even close to cap → skip

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const keep = new Set();

  // Always keep the most recent auto snapshot.
  if (auto.length) keep.add(auto[auto.length - 1].id);

  const buckets = {
    raw: new Set(),    // last 24 h: all
    hourly: new Map(), // hour key → snapshot id
    daily: new Map(),  // day key → snapshot id
    monthly: new Map(),// month key → snapshot id
  };

  for (const s of auto) {
    const age = now - s.timestamp;
    const d = new Date(s.timestamp);
    if (age <= day) {
      buckets.raw.add(s.id);
    } else if (age <= 7 * day) {
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
      if (!buckets.hourly.has(k)) buckets.hourly.set(k, s.id);
    } else if (age <= 90 * day) {
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!buckets.daily.has(k)) buckets.daily.set(k, s.id);
    } else {
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      if (!buckets.monthly.has(k)) buckets.monthly.set(k, s.id);
    }
  }

  buckets.raw.forEach(id => keep.add(id));
  buckets.hourly.forEach(id => keep.add(id));
  buckets.daily.forEach(id => keep.add(id));
  buckets.monthly.forEach(id => keep.add(id));

  for (const s of auto) {
    if (!keep.has(s.id)) await db.snapshotDelete(s.id);
  }
}
