// ============================================================
// sprint.js — Writing-sprint timer (Pomodoro-style).
//
// Modes: minutes (countdown) or words (count up to a target).
// On finish: rings a soft browser beep, marks chip "done", auto-publishes
// a snapshot named "Sprint YYYY-MM-DD HH:MM — N words".
//
// API:
//   setupSprint({ getTotalWords, publishSnapshot })
//   start({ kind: 'minutes'|'words', target: number })
//   stop()
//   isRunning()
// ============================================================

import { snapshotChapter } from './editor.js'; // optional, not used here directly

let _hooks = null;
let _running = false;
let _kind = 'minutes';
let _target = 25;
let _startTs = 0;
let _startWords = 0;
let _intervalId = null;
let _chip = null;
let _chipTime = null;
let _chipBar = null;
let _chipStop = null;

export function setupSprint(hooks) {
  _hooks = hooks;
  _chip = document.getElementById('sprint-chip');
  if (!_chip) return;
  _chipTime = _chip.querySelector('.sprint-chip-time');
  _chipBar  = _chip.querySelector('.sprint-chip-bar > span');
  _chipStop = _chip.querySelector('.sprint-chip-stop');
  _chipStop?.addEventListener('click', stop);
  _chip.hidden = true;
}

export function isRunning() { return _running; }

export function start({ kind, target }) {
  _kind = kind === 'words' ? 'words' : 'minutes';
  _target = Math.max(1, Number(target) || 0);
  _startTs = Date.now();
  _startWords = _hooks?.getTotalWords?.() ?? 0;
  _running = true;
  if (_chip) {
    _chip.hidden = false;
    _chip.classList.add('running');
    _chip.classList.remove('done');
  }
  if (_intervalId) clearInterval(_intervalId);
  _intervalId = setInterval(tick, 1000);
  tick();
}

export function stop(reason = 'manual') {
  if (!_running) return;
  _running = false;
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  if (_chip) {
    _chip.classList.remove('running');
    if (reason === 'completed') _chip.classList.add('done');
    setTimeout(() => { if (_chip && reason === 'manual') _chip.hidden = true; }, 100);
    if (reason === 'completed') setTimeout(() => { _chip.hidden = true; }, 8000);
  }
  // Final delta
  const written = (_hooks?.getTotalWords?.() ?? _startWords) - _startWords;
  if (reason === 'completed') {
    beep();
    const stamp = new Date().toLocaleString();
    const label = `Sprint ${stamp} — ${written} word${written === 1 ? '' : 's'}`;
    _hooks?.publishSnapshot?.(label).catch(() => {});
    _hooks?.toast?.(`Sprint complete — ${written} word${written === 1 ? '' : 's'}!`, 'success', 5000);
  }
}

function tick() {
  if (!_running) return;
  const now = Date.now();
  const elapsedMs = now - _startTs;
  if (_kind === 'minutes') {
    const totalMs = _target * 60_000;
    const remainMs = Math.max(0, totalMs - elapsedMs);
    if (_chipTime) _chipTime.textContent = formatMS(remainMs);
    if (_chipBar)  _chipBar.style.width = `${100 * (1 - remainMs / totalMs)}%`;
    if (remainMs <= 0) stop('completed');
  } else {
    const written = (_hooks?.getTotalWords?.() ?? _startWords) - _startWords;
    if (_chipTime) _chipTime.textContent = `${written}/${_target}`;
    if (_chipBar)  _chipBar.style.width = `${Math.min(100, (100 * written / _target))}%`;
    if (written >= _target) stop('completed');
  }
}

function formatMS(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    o.start(); o.stop(ctx.currentTime + 0.55);
    setTimeout(() => ctx.close(), 800);
  } catch {}
}
