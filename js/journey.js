// ============================================================
// journey.js — log + render milestone events.
// Events: started_chapter, completed_chapter, milestone_word_count,
//         re_entry_after_idle, personal_best_day, etc.
// ============================================================

import * as db from './db.js';
import { fmtTime, escapeHtml } from './utils.js';

const MILESTONE_WORDS = [1000, 5000, 10000, 25000, 50000, 75000, 100000];

/** Record a journey event (idempotent for some types: word milestones). */
export async function logEvent(type, title, detail = '') {
  // Avoid duplicate milestones.
  if (type === 'milestone_word_count') {
    const all = await db.journeyAll();
    if (all.some(e => e.type === type && e.title === title)) return;
  }
  await db.journeyAdd({ type, title, detail, timestamp: Date.now() });
  notifyTimelineDirty();
}

/** Check word-count milestones; logs any newly-crossed thresholds. */
export async function checkWordMilestones(currentWords, prevWords = 0) {
  for (const m of MILESTONE_WORDS) {
    if (prevWords < m && currentWords >= m) {
      await logEvent('milestone_word_count', `${m.toLocaleString()} words`,
        `You crossed ${m.toLocaleString()} total words.`);
    }
  }
}

/** Check for re-entry after >=3 days of inactivity. */
export async function checkReEntry() {
  const sessions = await db.sessionsAll();
  if (sessions.length < 2) return;
  const sorted = sessions.sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 2];  // previous active day
  const lastDate = new Date(last.date);
  const today = new Date();
  const daysGap = Math.floor((today - lastDate) / (24 * 60 * 60 * 1000));
  if (daysGap >= 3) {
    await logEvent('re_entry', `Welcome back`,
      `It's been ${daysGap} days since your last session — proud of you for showing up.`);
  }
}

let timelineDirty = true;
function notifyTimelineDirty() { timelineDirty = true; }

/** Render the journey timeline. */
export async function renderTimeline() {
  const root = document.getElementById('journey-timeline');
  if (!root) return;
  const events = (await db.journeyAll()).sort((a, b) => b.timestamp - a.timestamp);
  if (!events.length) {
    root.innerHTML = `<div class="empty-state">No milestones yet. Start writing — events log automatically.</div>`;
    return;
  }
  root.innerHTML = events.map(e => `
    <div class="timeline-item">
      <div class="timeline-time">${escapeHtml(fmtTime(e.timestamp))}</div>
      <div class="timeline-title">${iconFor(e.type)} ${escapeHtml(e.title)}</div>
      ${e.detail ? `<div class="timeline-detail">${escapeHtml(e.detail)}</div>` : ''}
    </div>
  `).join('');
  timelineDirty = false;
}

function iconFor(type) {
  switch (type) {
    case 'milestone_word_count': return '🎯';
    case 'started_chapter':       return '📝';
    case 'completed_chapter':     return '✅';
    case 'personal_best':         return '🏆';
    case 're_entry':              return '👋';
    default: return '•';
  }
}
