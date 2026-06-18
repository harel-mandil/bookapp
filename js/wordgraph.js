// ============================================================
// wordgraph.js — Daily word-count sparkline derived from snapshots.
//
// Source: each snapshot has { timestamp, words }. We walk snapshots in
// timestamp order, group by local-day, and use the LAST snapshot of each
// day as the day's word count. The "delta per day" is then a difference
// from the previous day's count.
//
// Output: an inline SVG sparkline rendered into a target element.
// ============================================================

import * as db from './db.js';

const DAYS = 30;

export async function renderWordSparkline(targetEl) {
  if (!targetEl) return;
  const all = (await db.snapshotsAll()).sort((a, b) => a.timestamp - b.timestamp);

  const now = new Date();
  const buckets = new Map();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), null);
  }
  // Track the last seen word-count before our window so we can compute
  // the delta on the first visible day correctly.
  let runningWords = 0;
  let firstWindowSeen = false;
  for (const s of all) {
    const key = new Date(s.timestamp).toISOString().slice(0, 10);
    if (buckets.has(key)) {
      buckets.set(key, s.words);
      firstWindowSeen = true;
    } else if (!firstWindowSeen) {
      runningWords = s.words;
    }
  }

  // Convert to deltas.
  const deltas = [];
  let prev = runningWords;
  for (const [day, words] of buckets) {
    if (words == null) {
      deltas.push({ day, delta: 0 });
    } else {
      deltas.push({ day, delta: Math.max(0, words - prev) });
      prev = words;
    }
  }

  // Render SVG.
  const max = Math.max(1, ...deltas.map(d => d.delta));
  const w = 800, h = 80, pad = 4;
  const barW = (w - pad * 2) / deltas.length;
  const bars = deltas.map((d, i) => {
    const bh = max ? ((d.delta / max) * (h - pad * 2)) : 0;
    const x = pad + i * barW;
    const y = h - pad - bh;
    const isToday = (i === deltas.length - 1);
    const fill = isToday ? 'var(--accent)' : 'var(--text-muted)';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}" rx="1"></rect>`;
  }).join('');
  const total = deltas.reduce((a, b) => a + b.delta, 0);
  const today = deltas[deltas.length - 1].delta;

  targetEl.innerHTML = `
    <h3>Last ${DAYS} days</h3>
    <div class="stat-sub"><strong>${total.toLocaleString()}</strong> words written · <strong>${today.toLocaleString()}</strong> today</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
  `;
}
