// ============================================================
// dashboard.js — render the dashboard view from current doc + sessions.
// ============================================================

import * as db from './db.js';
import { totalStats, stats, wordsOf } from './stats.js';
import { todayKey, fmtTime, escapeHtml } from './utils.js';
import { renderWordSparkline } from './wordgraph.js';

const STATUS_OPTIONS = ['outlined', 'drafting', 'done'];

/**
 * Render the full dashboard.
 * @param {object} doc the live book doc
 * @param {object} [hooks] optional callbacks { onGoalChange(chapterId, goal) }
 */
export async function renderDashboard(doc, hooks = {}) {
  const today = todayKey();
  const todaySession = (await db.sessionGet(today)) || { wordsAdded: 0 };
  const totals = totalStats(doc.chapters || []);

  // Hero
  setText('total-words', totals.words.toLocaleString());
  setText('today-words', (todaySession.wordsAdded || 0).toLocaleString());
  setText('reading-time', totals.readingLabel);
  setText('page-estimate', totals.pages.toLocaleString());

  // Word-count sparkline
  renderWordSparkline(document.getElementById('sparkline-card')).catch(() => {});

  // Daily goal
  const dailyGoal = await db.metaGet('dailyGoal', 500);
  setText('daily-goal', dailyGoal.toLocaleString());
  setText('daily-progress', (todaySession.wordsAdded || 0).toLocaleString());
  const pct = Math.min(100, Math.round(((todaySession.wordsAdded || 0) / Math.max(1, dailyGoal)) * 100));
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
  setText('session-words', (todaySession.wordsAdded || 0).toLocaleString());
  setText('session-time', todaySession.lastActiveAt ? fmtTime(todaySession.lastActiveAt) : '—');

  // Chapters table — now with a Goal column.
  const goals = (await db.metaGet('chapterGoals', {})) || {};
  const tbody = document.getElementById('chapters-table-body');
  if (tbody) {
    tbody.innerHTML = chapters.map((c, i) => {
      const s = stats(c.html || '');
      const status = c.status || 'drafting';
      const goal = goals[c.id] || 0;
      const goalPct = goal ? Math.min(100, Math.round((s.words / goal) * 100)) : 0;
      const bar = goal
        ? `<div class="chapter-goal-bar" title="${s.words}/${goal}"><span style="width:${goalPct}%"></span></div>`
        : '';
      return `
        <tr data-chapter-id="${escapeHtml(c.id)}">
          <td>${i + 1}</td>
          <td>${escapeHtml(c.title || 'Untitled')}</td>
          <td>${s.words.toLocaleString()}</td>
          <td class="chapter-goal-cell">
            <input type="number" min="0" step="100" data-goal-for="${escapeHtml(c.id)}" value="${goal || ''}" placeholder="—" />
            ${bar}
          </td>
          <td><span class="status-pill ${status}">${status}</span></td>
          <td>${s.readingLabel}</td>
        </tr>
      `;
    }).join('');
    tbody.onclick = (e) => {
      // Don't navigate on goal-input click.
      if (e.target.closest('.chapter-goal-cell')) return;
      const tr = e.target.closest('tr[data-chapter-id]');
      if (tr) {
        window.dispatchEvent(new CustomEvent('nav:chapter', { detail: { chapterId: tr.dataset.chapterId } }));
      }
    };
    tbody.querySelectorAll('input[data-goal-for]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const chId = inp.dataset.goalFor;
        const v = Math.max(0, parseInt(inp.value, 10) || 0);
        const next = { ...(await db.metaGet('chapterGoals', {})), [chId]: v };
        if (!v) delete next[chId];
        await db.metaSet('chapterGoals', next);
        hooks.onGoalChange?.(chId, v);
        renderDashboard(doc, hooks);
      });
      inp.addEventListener('click', e => e.stopPropagation());
    });
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
