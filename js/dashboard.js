// ============================================================
// dashboard.js — render the dashboard view from current doc + sessions.
// ============================================================

import * as db from './db.js';
import { totalStats, stats } from './stats.js';
import { todayKey, fmtTime, escapeHtml } from './utils.js';

const STATUS_OPTIONS = ['outlined', 'drafting', 'done'];

/**
 * Render the full dashboard.
 * @param {object} doc the live book doc
 */
export async function renderDashboard(doc) {
  const today = todayKey();
  const todaySession = (await db.sessionGet(today)) || { wordsAdded: 0 };
  const totals = totalStats(doc.chapters || []);

  // Hero
  setText('total-words', totals.words.toLocaleString());
  setText('today-words', todaySession.wordsAdded.toLocaleString());
  setText('reading-time', totals.readingLabel);
  setText('page-estimate', totals.pages.toLocaleString());

  // Daily goal
  const dailyGoal = await db.metaGet('dailyGoal', 500);
  setText('daily-goal', dailyGoal.toLocaleString());
  setText('daily-progress', todaySession.wordsAdded.toLocaleString());
  const pct = Math.min(100, Math.round((todaySession.wordsAdded / Math.max(1, dailyGoal)) * 100));
  const fill = document.getElementById('daily-progress-fill');
  if (fill) fill.style.width = pct + '%';

  // Streak
  const streak = await computeStreak();
  setText('streak-days', streak.toString());

  // Chapter counts by status
  const chapters = doc.chapters || [];
  const byStatus = { outlined: 0, drafting: 0, done: 0 };
  for (const c of chapters) byStatus[c.status || 'drafting']++;
  setText('chapter-count', chapters.length.toString());
  setText('chapter-done', byStatus.done.toString());
  setText('chapter-drafting', byStatus.drafting.toString());
  setText('chapter-outlined', byStatus.outlined.toString());

  // Last session info
  setText('session-words', todaySession.wordsAdded.toLocaleString());
  setText('session-time', todaySession.lastActiveAt ? fmtTime(todaySession.lastActiveAt) : '—');

  // Chapters table
  const tbody = document.getElementById('chapters-table-body');
  if (tbody) {
    tbody.innerHTML = chapters.map((c, i) => {
      const s = stats(c.html || '');
      const status = c.status || 'drafting';
      return `
        <tr data-chapter-id="${escapeHtml(c.id)}">
          <td>${i + 1}</td>
          <td>${escapeHtml(c.title || 'Untitled')}</td>
          <td>${s.words.toLocaleString()}</td>
          <td><span class="status-pill ${status}">${status}</span></td>
          <td>${s.readingLabel}</td>
        </tr>
      `;
    }).join('');
    tbody.onclick = (e) => {
      const tr = e.target.closest('tr[data-chapter-id]');
      if (tr) {
        window.dispatchEvent(new CustomEvent('nav:chapter', { detail: { chapterId: tr.dataset.chapterId } }));
      }
    };
  }
}

/** Calendar streak: consecutive days ending today (or yesterday) with ≥50 words added. */
async function computeStreak(threshold = 50) {
  const sessions = await db.sessionsAll();
  if (!sessions.length) return 0;
  const map = new Map(sessions.map(s => [s.date, s.wordsAdded || 0]));
  const today = new Date();
  let streak = 0;
  let cursor = new Date(today);

  // If today has 0 words, allow yesterday-anchored streak.
  if (!(map.get(todayKey(cursor)) >= threshold)) {
    cursor.setDate(cursor.getDate() - 1);
    if (!(map.get(todayKey(cursor)) >= threshold)) return 0;
  }

  while (true) {
    const k = todayKey(cursor);
    if ((map.get(k) || 0) >= threshold) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return streak;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export { STATUS_OPTIONS };
